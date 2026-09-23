# XSOAR Laya Trainer

This module contains the optional, experimental Laya data-review, compilation, training, and promotion-gate tooling. It is deliberately separate from the end-user XSOAR Incident Assistant and does not install or modify the XSOAR Incident Assistant.

The dependency direction is one way: trainer orchestration imports the production mapper contract so training examples match real inference. The production application never imports this module, its datasets, or its Python dependencies.

The installer contains the packaged trainer runtime, pinned configuration/schema files, and operating documentation. Reviewed-corpus ingestion and compilation remain source-controlled tools in this module because they must run against the matching repository revision before the packaged runtime trains their compiled output.

## Windows installer

`npm run package:laya-trainer:windows` builds a distinct per-user installer. Set:

- `TRAINER_RUNTIME_DIRECTORY` to a verified PyInstaller `laya-developer-trainer` directory.
- `TRAINER_BACKEND` to `cpu` or `cuda`.
- `APP_VERSION` to the package version when it is not inherited from npm.

CPU and CUDA packages are variants of the same trainer product and use a separate AppId and `%LOCALAPPDATA%\Programs\XSOAR Laya Trainer` directory. Neither package is an option inside the core installer.

The trainer remains experimental. Sequence accuracy is not production mapping accuracy, and no checkpoint is production-approved until it passes the frozen evaluation and promotion gates in [docs/training-pipeline.md](docs/training-pipeline.md).
