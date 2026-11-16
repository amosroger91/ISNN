"""Speak a list of narration parts with the local Qwen3-TTS clone of Isaac."""
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel
from scipy.signal import butter, correlate, resample_poly, sosfiltfilt


MAX_WORDS_PER_MINUTE = 215
MIN_WORDS_FOR_RATE_CHECK = 7
CODEC_FRAMES_PER_SECOND = 12.5
MATCH_RATE = 6000


def matches_reference(burst, rate, reference):
    """Look for the cloned reference waveform at a different gain or position."""
    probe = resample_poly(burst, MATCH_RATE, rate)
    if len(probe) > len(reference):
        return False
    score = correlate(reference, probe, mode="valid")
    energy = np.concatenate(([0.0], np.cumsum(np.square(reference, dtype=np.float64))))
    norms = np.sqrt(energy[len(probe):] - energy[:-len(probe)]) * np.linalg.norm(probe)
    return bool(np.any((norms > 1e-6) & (score > 0.72 * norms)))


def isolated_sound(speech_rms, start, stop):
    if not 9 <= stop - start <= 34:
        return False
    burst = speech_rms[start:stop]
    peak = float(np.max(burst))
    return bool(np.argmax(burst) < 0.55 * len(burst)
                and np.mean(burst[-4:]) < 0.55 * peak)


def tighten_silence(audio, rate, reference=None):
    """Remove generated padding and shorten only clearly silent internal gaps."""
    frame = rate // 100
    padded = np.pad(audio, (0, (-len(audio)) % frame))
    rms = np.sqrt(np.mean(padded.reshape(-1, frame) ** 2, axis=1))
    threshold = min(0.008, max(0.0015, float(np.max(rms, initial=0)) * 0.025))
    voiced = np.flatnonzero(rms > threshold)
    if not len(voiced):
        return audio, 0, False, False, False

    # Measure above the rumble band for detection only. Keep the original audio.
    highpass = butter(3, 220, fs=rate, btype="highpass", output="sos")
    highs = sosfiltfilt(highpass, padded).reshape(-1, frame)
    speech_rms = np.sqrt(np.mean(highs ** 2, axis=1))
    removed_thump = False
    gap = np.flatnonzero(np.diff(voiced) >= 11)
    if reference is not None and len(gap) and voiced[0] <= 24:
        index = gap[0]
        start = int(voiced[0])
        stop = int(voiced[index]) + 1
        if (5 <= stop - start <= 13
                and np.mean(rms[stop - 2:stop]) < 0.6 * np.max(rms[start:stop])
                and matches_reference(audio[(start + 1) * frame:(start + 5) * frame], rate, reference)):
            voiced = voiced[index + 1:]
            removed_thump = True
    if not removed_thump:
        # Some takes have a longer, bass-heavy onset whose tail bridges the gap
        # at the full-band threshold. Require a quiet interval above 220 Hz, a
        # decaying pulse, and normal speech afterward before removing the onset.
        start = int(voiced[0])
        speech_floor = max(threshold, float(np.max(speech_rms)) * 0.05)
        speech = np.flatnonzero(speech_rms > speech_floor)
        if len(speech) >= 8 and start <= 24:
            onset = int(speech[0])
            peak = float(np.max(rms[start:onset], initial=0))
            if (12 <= onset - start <= 42 and voiced[-1] >= onset + 7 and peak > threshold * 4
                    and np.max(rms[onset - 8:onset]) < peak * 0.4
                    and np.linalg.norm(speech_rms[start:onset - 8]) < 0.22 * np.linalg.norm(rms[start:onset - 8])):
                voiced = voiced[voiced >= onset - 2]
                removed_thump = True

    # A lone sound separated from the first or last words may be an added
    # vocalization. Ask for a retake instead of cutting possible speech.
    speech_floor = max(threshold * 1.3, float(np.max(speech_rms)) * 0.035)
    speech = np.flatnonzero(speech_rms[int(voiced[0]):] > speech_floor) + voiced[0]
    speech_gaps = np.flatnonzero(np.diff(speech) >= 19)
    suspicious_onset = False
    suspicious_tail = False
    if len(speech_gaps):
        suspicious_onset = isolated_sound(speech_rms, int(speech[0]), int(speech[speech_gaps[0]]) + 1)
        suspicious_tail = isolated_sound(speech_rms, int(speech[speech_gaps[-1] + 1]), int(speech[-1]) + 1)

    cursor = max(0, int(voiced[0]) - 2) * frame
    end = min(len(audio), (int(voiced[-1]) + 3) * frame)
    pieces = []
    fade = max(1, rate // 250)
    ramp = np.linspace(0, 1, fade, dtype=audio.dtype)
    active_frames = int(voiced[-1] - voiced[0] + 1)
    for left, right in zip(voiced[:-1], voiced[1:]):
        quiet_frames = int(right - left - 1)
        if quiet_frames >= 15:
            active_frames -= quiet_frames
        if quiet_frames >= 42:
            # Keep 220 ms at a real breath or sentence break.
            split_out = (int(left) + 12) * frame
            split_in = (int(right) - 11) * frame
            # The two quiet edges meet at zero instead of creating a hard splice.
            if not pieces:
                audio = audio.copy()
            audio[split_out - fade:split_out] *= ramp[::-1]
            audio[split_in:split_in + fade] *= ramp
            pieces.append(audio[cursor:split_out])
            cursor = split_in
    pieces.append(audio[cursor:end])
    return np.concatenate(pieces), active_frames * frame / rate, removed_thump, suspicious_onset, suspicious_tail


def synthesize(model, prompt, text, words, reference):
    # Allow generous room for names and numbers, while bounding runaway takes.
    budget = max(112, int((3 + 0.75 * words) * CODEC_FRAMES_PER_SECOND))
    wavs, rate = model.generate_voice_clone(
        text=text,
        language="English",
        voice_clone_prompt=prompt,
        non_streaming_mode=True,
        max_new_tokens=budget,
    )
    raw = wavs[0]
    if len(raw) >= (budget - 3) * rate / CODEC_FRAMES_PER_SECOND:
        return raw, rate, 0, False, False, False
    audio, active_seconds, removed_thump, suspicious_onset, suspicious_tail = tighten_silence(raw, rate, reference)
    return audio, rate, active_seconds, removed_thump, suspicious_onset, suspicious_tail


def main():
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(job["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    print("LOADING", file=sys.stderr, flush=True)
    model = Qwen3TTSModel.from_pretrained(
        job["model"],
        device_map="cuda:0",
        dtype=torch.bfloat16,
        attn_implementation="sdpa",
    )
    ref_text = Path(job["refText"]).read_text(encoding="utf-8").strip()
    prompt = model.create_voice_clone_prompt(ref_audio=job["refAudio"], ref_text=ref_text)
    reference_audio, reference_rate = sf.read(job["refAudio"], dtype="float32", always_2d=True)
    reference = resample_poly(reference_audio.mean(axis=1), MATCH_RATE, reference_rate)
    files = []
    pacing = []
    rate = None
    for index, text in enumerate(job["parts"]):
        print(f"PART {index + 1}/{len(job['parts'])}", file=sys.stderr, flush=True)
        words = len(re.findall(r"\b\w+(?:[’']\w+)*\b", text))
        audio, rate, active_seconds, removed_thump, onset, tail = synthesize(model, prompt, text, words, reference)
        rushed = words >= MIN_WORDS_FOR_RATE_CHECK and words > active_seconds * MAX_WORDS_PER_MINUTE / 60
        retried = rushed or onset or tail or not active_seconds
        attempts = 2 if onset or tail else int(retried)
        for _ in range(attempts):
            print(f"RETAKE {index + 1}", file=sys.stderr, flush=True)
            retry, retry_rate, retry_seconds, retry_removed_thump, retry_onset, retry_tail = synthesize(model, prompt, text, words, reference)
            closer_to_target = retry_seconds and active_seconds and (
                abs(60 * words / retry_seconds - 180) < abs(60 * words / active_seconds - 180)
            )
            flags = int(onset) + int(tail)
            retry_flags = int(retry_onset) + int(retry_tail)
            if retry_seconds and (not active_seconds or retry_flags < flags
                                  or (retry_flags == flags and closer_to_target)):
                audio, rate, active_seconds, removed_thump, onset, tail = retry, retry_rate, retry_seconds, retry_removed_thump, retry_onset, retry_tail
            if active_seconds and not (onset or tail):
                break
        if not active_seconds:
            raise RuntimeError(f"Isaac's voice did not finish a usable take for phrase {index + 1}.")
        words_per_minute = round(60 * words / active_seconds)
        pacing.append({
            "index": index,
            "wordsPerMinute": words_per_minute,
            "retried": retried,
            "referenceThumpRemoved": removed_thump,
            "suspiciousOnset": onset,
            "suspiciousTail": tail,
            "rushed": words >= MIN_WORDS_FOR_RATE_CHECK and words_per_minute > MAX_WORDS_PER_MINUTE,
        })
        file = out_dir / f"part-{index:03d}.wav"
        sf.write(file, audio, rate, subtype="PCM_16")
        files.append(file.name)
    result = out_dir / "result.json"
    result.write_text(json.dumps({"rate": rate, "files": files, "pacing": pacing}), encoding="utf-8")
    print(result, file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
