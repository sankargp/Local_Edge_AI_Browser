# Bundled Whisper runtime

The `win-x64/` directory contains the official Windows x64 CPU artifacts from
`ggml-org/whisper.cpp` build `b5130`. That build and the signed `v1.9.4` release
both identify source commit `927cfce`.

- `whisper-cli.exe`
- the CPU backend DLLs from the same archive
- `LICENSE`
- `CHECKSUMS.sha256`

The original archive SHA-256 is
`f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c`.
Individual shipped-file hashes are recorded in `CHECKSUMS.sha256`.

The runtime is intentionally not downloaded by the application. Developers can set
`WHISPER_CPP_PATH` to a compatible locally built `whisper-cli.exe`. The speech model
is a separate, checksum-verified first-use download stored in Electron's user-data
directory.

Do not replace the runtime with a different build without updating
`config/speech.json`, this file, the checksums, and the third-party attribution.
