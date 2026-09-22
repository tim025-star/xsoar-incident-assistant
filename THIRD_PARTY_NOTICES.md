# Third-party notices

## Laya

The optional Laya-mapper installer can download self-contained application-local CPU inference, CPU training, and CUDA training archives plus the `laya-multilingual` checkpoint built from Laya `0.3.5`. Laya is maintained by ConvAI Innovations and distributed under the Apache License 2.0. The model checkpoint retains the licence and provenance published with the upstream project. These files are not bundled in the main Windows installer; each separately published GitHub Release asset is pinned by byte length and SHA-256 in the release manifest embedded in that installer. The archives include their pinned Python, PyTorch, Transformers, Safetensors, and supporting runtime dependencies, so client computers do not need a system Python installation.

- Project: https://github.com/NandhaKishorM/laya
- License: https://github.com/NandhaKishorM/laya/blob/main/LICENSE

## Qwen3.5 9B model weights

The optional local-AI installer can download Qwen3.5 9B Q4_K_M model weights. Qwen3.5 is provided by the Qwen Team at Alibaba Cloud and its open-weight models are licensed under the Apache License 2.0.

The application does not bundle the weights in its Windows installer. The separately published model-asset release includes `QWEN3.5-LICENSE.txt`, copied byte-for-byte from the license layer distributed with Ollama's `qwen3.5:9b` manifest.

- Project: https://github.com/QwenLM/Qwen3.5
- License: https://www.apache.org/licenses/LICENSE-2.0
- Unmodified Ollama model-layer SHA-256: `dec52a44569a2a25341c4e4d3fee25846eed4f6f0b936278e3a3c900bb99d37c`

## Ollama

The optional local-AI installer downloads the official Ollama Windows installer from Ollama's GitHub Release. Ollama is distributed under the MIT License.

- Project: https://github.com/ollama/ollama
- License: https://github.com/ollama/ollama/blob/main/LICENSE
