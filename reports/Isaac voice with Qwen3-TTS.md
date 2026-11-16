# Isaac's voice on the local GPU

**Status: plan for review. No code in this change.**
**Recorded 2026-11-15 from this machine and from the Qwen3-TTS release notes.**

The show should be narrated in a clone of Isaac's voice. Kokoro's `am_michael` stays only as the fallback when the clone is unreachable. The clone is free, local, and Apache-2.0. It does not run inside Ollama.

## Decision

Use **Qwen3-TTS-12Hz-1.7B-Base**, the checkpoint that clones from a short reference clip. Host it as a localhost speech server through **voicy** with the **q8_0** talker GGUF, not through the official PyTorch bf16 loader and not through Ollama.

That is the highest-quality clone that fits this GPU. The full-precision 1.7B loader wants about 5.6 GB on its own, and this card has 6 GB while also driving the desktop. The q8_0 conversion is the same 1.7B Base weights. On the publisher's RTX 3080 bench it used **2.6 GB**, character error **2.2%** against **2.1%** for PyTorch, and speaker similarity **0.986** against **0.985**. q5_k was 2.2 GB with the same similarity. Those numbers are not from this 3050. The first implementation step is to measure them here.

If q8_0 does not stay resident, drop to q5_k of the same 1.7B Base. If that does not fit either, drop to **Qwen3-TTS-12Hz-0.6B-Base**, which still clones and is the same family. Do not switch to XTTS. Its license is non-commercial. Do not switch to a preset Kokoro voice and call it Isaac.

Ollama 0.40.15 is installed and is the research model host. It has no speech API. A Hugging Face "run with Ollama" button on a TTS GGUF does not supply the codec decoder and the speaker encoder this clone needs. voicy is the server those GGUF and ONNX files were built for. Binding it to `127.0.0.1` is the host. Revisit Ollama only if a later release documents a Qwen3-TTS speech endpoint that accepts a reference clip and returns WAV.

## This machine

Measured with `nvidia-smi` and `ollama ps` while writing this plan.

| Item | Value |
| --- | --- |
| GPU | NVIDIA GeForce RTX 3050, 6144 MiB, compute 8.6, driver 621.14 |
| Display mode | WDDM. The card is driving the desktop, so Windows keeps a share of the memory |
| Use at measurement | 5603 MiB of 6144 MiB. About 366 MiB free |
| What filled it | `ollama` runner for `qwen3.5:9b`, 6.3 GB split 43% CPU / 57% GPU, plus the desktop |
| CPU | AMD Ryzen 7 5700, 8 cores / 16 threads |
| RAM | 16 GB |
| Ollama | 0.40.15, already the desk's research server at `http://127.0.0.1:11434` |

The research model and the voice model cannot be resident together. A 9B runner that already spills onto the CPU leaves no room for a second model. Narration has to unload Ollama first. The next chat or research call loads it again, which Ollama already does on demand.

The Compose host in `deploy/docker-compose.yml` is two vCPUs and 1,800 MB, and it has no GPU. The clone does not go in that image. A desk on that host keeps Kokoro unless `SPORTS_TTS_URL` points at a machine that actually has the 3050.

## What narration does today

`narrateParts` in `server/voice.mjs` loads Kokoro-82M on the CPU, speaks each part, and writes one 24 kHz 16-bit mono WAV. It returns the start and end of every part. Those times are the caption clock. `renderEpisode` in `server/sports/produce.mjs` calls it with `SPORTS_VOICE` (default `am_michael`) at speed `1.02`, then FFmpeg loudness-normalizes to the house target and encodes 48 kHz AAC.

Parts come from `narrationParts`. Each segment is split into sentences and wrapped near 245 characters, with a 0.19 s pause inside a chapter and 0.52 s at the end of one. The returned `segments[].kind` is the chapter index. Shorts are cut from the same WAV. One timing error shifts every caption and every Short.

Kokoro is unloaded after the call (`engine = null` and `dispose`) so the render has the RAM. Tests pass their own `narrate` function and never load a model. `npm run render:fixture -- --voice none` uses `placeholderNarrate` and must keep doing that.

Credits and `timeline.json` record `engine: "kokoro"` and the disclosure `synthetic narrator`.

## Model

Official release: [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS), 22 January 2026, Apache-2.0. Five checkpoints. Only the **Base** pair clones.

| Checkpoint | Clone | Why it is or is not the one |
| --- | --- | --- |
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | Yes, from about 3 seconds plus a transcript | The one to run |
| `Qwen/Qwen3-TTS-12Hz-0.6B-Base` | Yes | Fallback if 1.7B will not reside |
| `1.7B-CustomVoice` and `0.6B-CustomVoice` | No. Nine built-in speakers | Not Isaac |
| `1.7B-VoiceDesign` | No. A voice from a text description | Not Isaac |

Output is 24 kHz mono, which is already what `wav()` in `voice.mjs` writes. Languages include English. Instruction control of emotion is on CustomVoice and VoiceDesign, not on Base. Pace and tone come from Isaac's reference clip.

Clone mode for the show is in-context, with the reference audio and its exact transcript. The speaker-embedding-only path is the lower-fidelity option and is not the default.

Quantized runner, so the 1.7B weights fit:

- Talker `q8_0` from [sknyazev/qwen3-tts-12hz-1.7b-base-gguf](https://huggingface.co/sknyazev/qwen3-tts-12hz-1.7b-base-gguf), plus the predictor, the fp16 ONNX decoder, and the speaker and codec encoders in that same repo.
- Server: `voicy serve`, bound to `127.0.0.1` and a port that does not collide with the desk (`4320`) or Ollama (`11434`). `8787` is the suggestion.
- `TTS_GGUF_TALKER=q8_0`. Switch to `q5_k` only after an out-of-memory result.
- The PyTorch package `qwen-tts` at bf16 is the quality reference for an A/B listen. It is not the server. A published measurement put that loader at 5.6 GB, which will not coexist with the desktop on this card.

FlashAttention is optional and is for the PyTorch loader. Skip it unless that A/B is run. The 3050 is Ampere, so the kernel is eligible, and a build on 16 GB of RAM needs `MAX_JOBS=4`.

## Reference clip

Isaac records it. Nothing is scraped from old video, a podcast, or YouTube.

- 10 to 20 seconds, one take, mono, 24 kHz or higher. A quiet room. No music, no other voice, no heavy room tone.
- He reads a sports paragraph at the pace the show should have. Scores, team names, and a short opinion sentence, because that is what the overnight copy sounds like.
- The transcript is exact, including the numbers as he said them. Save `isaac.wav` and `isaac.txt` under `DATA_DIR/sports/voice/`. That directory stays out of git.
- A one-line consent note beside them: Isaac agrees this clip may be cloned for ISNN episodes and Shorts. The model license does not replace that.
- Listen to a frozen test paragraph before any episode build. If the clone drifts, the next step is a fine-tune on a few minutes of the same kind of read, using the fine-tuning path in the Qwen repo. Fine-tuning is not part of the first patch.

Pronunciation is a desk concern, not a model one. Captions keep digits. The text sent to the server spells the hard cases: `116-108` becomes the way Isaac says a score, `Jokic` is given a phonetic hint only where a listen proves it is wrong. Do that in the `prepareText` hook `narrateParts` already accepts, so the caption source string stays the original sentence.

## Runtime

voicy stays up while the desk is open. The Node process does not load PyTorch.

Before the first clone call of a render:

1. Read free VRAM. If it is under about 3 GB, run `ollama stop` on whatever `ollama ps` shows, then look again.
2. Call the voice server. If it is down, start it once and wait until a health check answers.
3. If it still cannot load, fall through to Kokoro and say so on the render progress line and in credits. The episode still encodes. A missing voice server is not a failed morning.

After narration, leave voicy loaded if free memory allows, so an edit during the night does not pay the load again. The next research or chat call may load `qwen3.5:9b` and evict the voice. That is acceptable. The desk already serializes edition work, so a chat does not run in the middle of a render.

Generation is one request per narration part, in order. The server returns WAV for that sentence. `narrateParts` keeps the lead-in, the edge fade, the pauses, and the segment clock it has now. Do not send a whole episode as one request. A single blob has no chapter times, and long Base generations are where clones wander.

Cache each part at `DATA_DIR/sports/voice-cache/`, keyed by the hash of the spoken text, the reference-clip hash, the model id, and the talker quant. A rebuild that did not change a sentence reuses the WAV. Cap the cache, on the order of 2 GB, and drop files no current edition names.

Expected speed on this card is unknown until the smoke test. Budget a 12-minute speak track as several minutes of GPU time, inside the render worker's 40-minute limit, with the cache making the second cut cheap. Generate parts one at a time. A batch big enough to raise the KV cache will blow the 6 GB card. The GGUF notes put a 32-wide batch near 3.6 GB before the desktop's share.

Kokoro's `speed` argument is not a Qwen parameter. Do not time-stretch Isaac to chase `1.02`. The reference clip sets the pace.

## Desk wiring

Keep the `narrateParts(parts, voice, file, report, signal, options)` signature so `renderEpisode` and the tests stay put.

- `SPORTS_TTS=qwen` selects the clone. Unset, or `kokoro`, keeps today's path.
- `SPORTS_TTS_URL=http://127.0.0.1:8787` is the server. Refuse any other host unless it is loopback. This machine is the GPU.
- `SPORTS_VOICE=isaac` selects the reference clip. Unknown Kokoro names still fall back to `am_michael` when the engine is Kokoro.
- `narration.engine` becomes `qwen3-tts-1.7b-base-q8` or `kokoro`. Credits disclosure becomes `synthetic narration in a clone of Isaac's voice` when the clone ran, and stays `synthetic narrator` for Kokoro. YouTube's synthetic-media toggle stays a human step at upload. The code records the disclosure. It does not claim the label was set.
- `render-worker.mjs` inherits the env. It talks to the already-running server. It does not download weights.
- `--voice none` and `placeholderNarrate` are unchanged, and CI stays offline.
- `VOICES` in the client can list Isaac beside the Kokoro names. The practice desk does not grow a voice picker in this patch unless the header already has a place for it. The env value is enough.

`server/voice.mjs` grows a second engine function. The WAV writer, the fade, and the pause math stay shared. Kokoro's dynamic import stays behind the Kokoro branch so a Qwen render does not load `kokoro-js`.

New process, not new application code in the request path:

- `scripts/voice-server.mjs` or a short README section that starts voicy with the model dir under `MODEL_CACHE_DIR`. Prefer a script the desk can spawn, the way it already spawns the render worker, over a manual terminal step.
- Weights live in the model cache, not in the repo and not in the Docker image.

`.env.example` and the README "Run locally" section gain the three variables and one sentence: the first Qwen render downloads a few gigabytes onto this PC, and the 1,800 MB server does not run the clone.

## Smoke test before wiring the desk

Do this on the 3050 with Ollama stopped, and write the numbers into the handoff.

1. Free VRAM after `ollama stop`, with the desktop left as it is.
2. Load q8_0 1.7B Base. Record resident VRAM.
3. Clone the reference clip onto the frozen test paragraph. Save the WAV.
4. Repeat with q5_k only if step 2 failed.
5. Time ten sentences of about 200 characters. Note real-time factor and whether the voice holds from sentence to sentence.
6. Confirm the process is gone from the GPU after a stop, so the research model can load again.

Pass means q8_0 or q5_k stays under the memory Windows actually leaves, the paragraph is intelligible, and Isaac accepts the voice on headphones. Fail means try 0.6B Base the same way and stop. Do not paper over a bad clone by shipping it.

A later A/B against PyTorch bf16 is optional and only if someone runs it on a larger card. It is not a gate for this PC.

## Tests

Existing production tests inject `narrate` and do not change.

Add a unit test that points the Qwen client at a local stub HTTP server. The stub returns a tiny WAV. The client writes the episode WAV, preserves part order and pauses, and tags `engine`. No GPU, no weights, no network off the machine.

`npm test`, `npm run build`, and `npm run render:fixture -- --voice none` stay green and make no speech-server call.

One manual listen: `npm run render:fixture` with `SPORTS_TTS=qwen` and the placeholder flag off, after Isaac has approved the clip. That file is a local proof. It is not uploaded.

## Order of work

1. Record the clip and the consent line. No code.
2. Install voicy, download the 1.7B Base q8_0 set into the model cache, run the smoke test, and keep the VRAM and timing notes.
3. Add the HTTP engine beside Kokoro, including the Ollama unload when VRAM is tight, the part cache, and the spoken-number hook.
4. Point credits and the timeline at the engine that actually spoke.
5. Stub test, then the three existing commands, then one listened fixture render.

## Do not

- Do not load `Qwen/Qwen3-TTS-12Hz-1.7B-Base` in PyTorch bf16 on this 3050 as the production server. Use it only as an optional listen on a card that has the memory.
- Do not leave `qwen3.5:9b` loaded while the voice model loads.
- Do not put the reference clip, the consent note, or the weights in git.
- Do not send desk text to any host except `127.0.0.1`.
- Do not clone anyone but Isaac, and do not clone Isaac from audio he did not record for this.
- Do not drop `--voice none` or make `npm test` depend on the GPU.
- Do not time-stretch the clone to match Kokoro's `1.02` speed.
- Do not describe the result as Isaac speaking live. Credits say it is a synthetic clone.
