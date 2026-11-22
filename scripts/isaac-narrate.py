"""Speak a list of narration parts with the local Qwen3-TTS clone of Isaac."""
import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel
from scipy.signal import butter, correlate, resample_poly, sosfiltfilt


MAX_WORDS_PER_MINUTE = 240
# Lines faster than this are retaken once; the average take is about 200 wpm.
RETAKE_WORDS_PER_MINUTE = 240
# Slower than this on a line of 4+ words is a loop or stutter, not a read.
STUTTER_WORDS_PER_MINUTE = 90
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


def synthesize_batch(model, prompt, texts, word_counts, reference):
    """Speak several lines in one pass. Returns one take per line."""
    budgets = [max(112, int((3 + 0.75 * words) * CODEC_FRAMES_PER_SECOND)) for words in word_counts]
    batched = len(texts) > 1
    wavs, rate = model.generate_voice_clone(
        text=texts if batched else texts[0],
        language=["English"] * len(texts) if batched else "English",
        voice_clone_prompt=prompt,
        non_streaming_mode=True,
        max_new_tokens=max(budgets),
    )
    takes = []
    for raw, budget, words in zip(wavs, budgets, word_counts):
        audio, active_seconds, removed_thump, suspicious_onset, suspicious_tail = tighten_silence(raw, rate, reference)
        # A take that reaches its own budget is a runaway (in a batch, shorter
        # lines share the longest line's budget, so each is held to its own).
        capped = bool(active_seconds) and len(raw) >= (budget - 3) * rate / CODEC_FRAMES_PER_SECOND
        # The clone sometimes loops on a syllable ("stutters") until it runs out
        # of budget. Speech far slower than any natural read is the same failure.
        if active_seconds and words_slow(words, active_seconds):
            capped = True
        takes.append({"audio": audio, "rate": rate, "seconds": active_seconds, "thump": removed_thump,
                      "onset": suspicious_onset, "tail": suspicious_tail, "capped": capped})
    return takes


def words_slow(words, seconds):
    """True when a take is far slower than speech: a loop or stutter, not a read."""
    return words >= 4 and seconds > 2.5 and 60 * words / seconds < STUTTER_WORDS_PER_MINUTE


def split_text(text):
    """Split a line near its middle at a sentence or clause break, else at a space."""
    middle = len(text) // 2
    for marks in (".!?", ";:", ",—–", " "):
        spots = [index + 1 for index, char in enumerate(text) if char in marks and 0 < index < len(text) - 1]
        if spots:
            cut = min(spots, key=lambda spot: abs(spot - middle))
            left, right = text[:cut].strip(), text[cut:].strip()
            if left and right:
                return left, right
    return None


def rescue_stutters(model, prompt, lines, best, reference, batch_size):
    """Say a line that keeps looping as two shorter halves, joined by a short breath."""
    halves = []
    for line in lines:
        parts = split_text(line["text"])
        if not parts:
            continue
        for side, text in zip(("a", "b"), parts):
            words = len(re.findall(r"\b\w+(?:[’']\w+)*\b", text))
            halves.append({"index": f"{line['index']}{side}", "text": text, "words": words, "line": line})
    if not halves:
        return
    takes = generate_batches(model, prompt, halves, reference, batch_size, lambda count: None)
    for line in lines:
        left, right = takes.get(f"{line['index']}a"), takes.get(f"{line['index']}b")
        if not left or not right or not left["seconds"] or not right["seconds"] or left["capped"] or right["capped"]:
            continue
        rate = left["rate"]
        gap = np.zeros(int(rate * 0.12), dtype=left["audio"].dtype)
        best[line["index"]] = {
            "audio": np.concatenate([left["audio"], gap, right["audio"]]), "rate": rate,
            "seconds": left["seconds"] + right["seconds"], "thump": left["thump"] or right["thump"],
            "onset": left["onset"], "tail": right["tail"], "capped": False,
        }


def flags(take):
    return int(take["onset"]) + int(take["tail"]) + int(take["capped"])


def better(new, old, words):
    """Prefer the take with fewer problems, then the one closer to 180 wpm."""
    if not new["seconds"]:
        return False
    if not old["seconds"]:
        return True
    if flags(new) != flags(old):
        return flags(new) < flags(old)
    return abs(60 * words / new["seconds"] - 180) < abs(60 * words / old["seconds"] - 180)


def needs_retake(take, words):
    if not take["seconds"]:
        return True
    rushed = words >= MIN_WORDS_FOR_RATE_CHECK and words > take["seconds"] * RETAKE_WORDS_PER_MINUTE / 60
    return bool(rushed or take["onset"] or take["tail"] or take["capped"])


def take_key(job, profile, voice, text):
    """Identify a take by everything that shapes it, so a rerun can reuse it."""
    source = json.dumps([job["model"], voice, profile["refAudio"], profile["refText"], text], ensure_ascii=False)
    return hashlib.sha256(source.encode("utf-8")).hexdigest()[:32]


def generate_batches(model, prompt, items, reference, batch_size, progress):
    """Speak items in groups of similar length. Halve the group on a GPU memory error."""
    ordered = sorted(items, key=lambda item: item["words"])
    results = {}
    index = 0
    size = batch_size
    while index < len(ordered):
        group = ordered[index:index + size]
        try:
            takes = synthesize_batch(model, prompt, [item["text"] for item in group], [item["words"] for item in group], reference)
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            if size == 1:
                raise
            size = max(1, size // 2)
            print(f"BATCH {size}", file=sys.stderr, flush=True)
            continue
        for item, take in zip(group, takes):
            results[item["index"]] = take
        index += len(group)
        progress(len(group))
    return results


def write_atomic_wav(path, audio, rate):
    temporary = path.with_name(path.name + ".tmp")
    sf.write(temporary, audio, rate, subtype="PCM_16", format="WAV")
    temporary.replace(path)


def main():
    job = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out_dir = Path(job["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    profiles = {"isaac": job, **job.get("profiles", {})}
    voices = job.get("partVoices", ["isaac"] * len(job["parts"]))
    cache_dir = Path(job["cacheDir"]) if job.get("cacheDir") else None
    if cache_dir:
        cache_dir.mkdir(parents=True, exist_ok=True)
    batch_size = max(1, int(job.get("batchSize") or 4))
    total = len(job["parts"])

    # Reuse every line already recorded by an earlier attempt or the pre-record pass.
    lines = []
    for index, text in enumerate(job["parts"]):
        voice = voices[index]
        key = take_key(job, profiles[voice], voice, text) if cache_dir else None
        words = len(re.findall(r"\b\w+(?:[’']\w+)*\b", text))
        line = {"index": index, "text": text, "voice": voice, "key": key, "words": words, "take": None, "pacing": None}
        if key and (cache_dir / f"{key}.wav").exists() and (cache_dir / f"{key}.json").exists():
            try:
                audio, rate = sf.read(cache_dir / f"{key}.wav", dtype="float32")
                line["pacing"] = json.loads((cache_dir / f"{key}.json").read_text(encoding="utf-8"))
                if len(audio):
                    line["take"] = {"audio": audio, "rate": rate}
            except Exception:
                # A damaged cache entry is recorded again.
                line["take"] = None
        lines.append(line)
    missing = [line for line in lines if line["take"] is None]
    recorded = total - len(missing)
    print(f"PART {recorded}/{total}", file=sys.stderr, flush=True)

    if missing:
        print("LOADING", file=sys.stderr, flush=True)
        model = Qwen3TTSModel.from_pretrained(
            job["model"],
            device_map="cuda:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
        )

        def first_pass_progress(count):
            nonlocal recorded
            recorded += count
            print(f"PART {recorded}/{total}", file=sys.stderr, flush=True)

        # A line that cannot be recorded stops the build only after every other
        # line is cached, so the retry after rewording it records just that line.
        problems = []
        for voice in dict.fromkeys(line["voice"] for line in missing):
            profile = profiles[voice]
            ref_text = Path(profile["refText"]).read_text(encoding="utf-8").strip()
            prompt = model.create_voice_clone_prompt(ref_audio=profile["refAudio"], ref_text=ref_text)
            reference_audio, reference_rate = sf.read(profile["refAudio"], dtype="float32", always_2d=True)
            reference = resample_poly(reference_audio.mean(axis=1), MATCH_RATE, reference_rate)
            todo = [line for line in missing if line["voice"] == voice]
            best = generate_batches(model, prompt, todo, reference, batch_size, first_pass_progress)
            retried = set()
            # One retake round for lines with a real problem; empty or cut-off
            # lines get a second round. Retakes are batched too.
            for round_number in range(2):
                again = [line for line in todo if needs_retake(best[line["index"]], line["words"])
                         and (round_number == 0 or not best[line["index"]]["seconds"] or best[line["index"]]["capped"])]
                if not again:
                    break
                for line in again:
                    print(f"RETAKE {line['index'] + 1}", file=sys.stderr, flush=True)
                    retried.add(line["index"])
                second = generate_batches(model, prompt, again, reference, batch_size, lambda count: None)
                for line in again:
                    if better(second[line["index"]], best[line["index"]], line["words"]):
                        best[line["index"]] = second[line["index"]]
            # Still looping after two retakes: record the line as two halves.
            looping = [line for line in todo if best[line["index"]]["capped"]]
            if looping:
                for line in looping:
                    print(f"SPLIT {line['index'] + 1}", file=sys.stderr, flush=True)
                rescue_stutters(model, prompt, looping, best, reference, batch_size)
            for line in todo:
                take = best[line["index"]]
                if not take["seconds"]:
                    problems.append(f"Isaac's voice did not finish a usable take for phrase {line['index'] + 1}.")
                    continue
                if take["capped"]:
                    # Never air a looping take.
                    problems.append(f"Isaac's voice kept stuttering on phrase {line['index'] + 1}: \"{line['text'][:80]}\". Reword that line and build again.")
                    continue
                words_per_minute = round(60 * line["words"] / take["seconds"])
                line["take"] = take
                line["pacing"] = {
                    "voice": voice,
                    "wordsPerMinute": words_per_minute,
                    "retried": line["index"] in retried,
                    "referenceThumpRemoved": take["thump"],
                    "suspiciousOnset": take["onset"],
                    "suspiciousTail": take["tail"],
                    "rushed": line["words"] >= MIN_WORDS_FOR_RATE_CHECK and words_per_minute > MAX_WORDS_PER_MINUTE,
                }
                if line["key"]:
                    # Atomic writes: a killed run never leaves half a take in the cache.
                    write_atomic_wav(cache_dir / f"{line['key']}.wav", take["audio"], take["rate"])
                    meta = cache_dir / f"{line['key']}.json.tmp"
                    meta.write_text(json.dumps(line["pacing"]), encoding="utf-8")
                    meta.replace(cache_dir / f"{line['key']}.json")
        if problems:
            raise RuntimeError(" ".join(problems))
        del model
        torch.cuda.empty_cache()

    files = []
    pacing = []
    rate = None
    for line in lines:
        rate = line["take"]["rate"]
        file = out_dir / f"part-{line['index']:03d}.wav"
        sf.write(file, line["take"]["audio"], rate, subtype="PCM_16")
        files.append(file.name)
        pacing.append({"index": line["index"], **line["pacing"]})
    result = out_dir / "result.json"
    result.write_text(json.dumps({"rate": rate, "files": files, "pacing": pacing}), encoding="utf-8")
    print(result, file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
