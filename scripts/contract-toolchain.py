import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
VERSION = "v0.6.0-rc5"
BUNDLE_SHA256 = "bd30580f911338d5533460eca8ed714dec371de5803c04e41dbb96430aea7b6e"
RUNNERS = (
    "py-genlayer/5j/ycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng.zip",
    "py-lib-genlayer-std/kz/r02ndm9et4qkmbqpq5djjt5sme2yt76n7sz1qbzax0knt6mam0.zip",
)
RUNTIME = ROOT / ".runtime" / "genvm"


def setup():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    bundle = RUNTIME / f"universal-{VERSION}.tar.xz"
    if not bundle.exists():
        url = f"https://github.com/genlayerlabs/genvm-manager/releases/download/{VERSION}/genvm-universal.tar.xz"
        temporary = bundle.with_suffix(".download")
        with urllib.request.urlopen(url, timeout=300) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        temporary.replace(bundle)
    with bundle.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != BUNDLE_SHA256:
            raise RuntimeError(f"Bundle checksum mismatch; remove {bundle} and retry")
    wanted = set(RUNNERS)
    with tarfile.open(bundle, "r:xz") as archive:
        for member in archive:
            suffix = member.name.partition("runners/")[2]
            if suffix not in wanted or not member.isfile():
                continue
            destination = RUNTIME / "tree" / "runners" / suffix
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source:
                destination.write_bytes(source.read())
            wanted.remove(suffix)
            if not wanted:
                break
    if wanted:
        raise RuntimeError(f"Pinned runners missing: {sorted(wanted)}")
    print(f"Verified and extracted pinned GenVM {VERSION} runners")


def load_pinned_sdk(contract_path, progress_callback=None):
    import numpy
    from genvm_linter.validate.sdk_loader import setup_wasi_mocks
    from gltest.direct.sdk_loader import setup_sdk_paths

    setup_wasi_mocks()
    setup_sdk_paths(contract_path)
    from genlayer._internal.get_schema import get_schema

    return get_schema, []


def main():
    os.chdir(ROOT)
    action = sys.argv[1] if len(sys.argv) > 1 else "check"
    if action == "setup":
        setup()
        return
    if not all((RUNTIME / "tree" / "runners" / runner).is_file() for runner in RUNNERS):
        raise RuntimeError("Run npm run setup:contracts before contract checks")
    os.environ["GENVM_PREBUILT_DIR"] = str(RUNTIME / "tree")
    os.environ["GENVM_VERSION"] = VERSION
    if action == "test":
        raise SystemExit(subprocess.call([sys.executable, "-m", "pytest", *sys.argv[2:]]))
    if action not in ("check", "schema"):
        raise RuntimeError(f"Unsupported toolchain action: {action}")
    import genvm_linter.validate.validator as validator
    from genvm_linter.cli import cli

    validator.load_sdk = load_pinned_sdk
    sys.argv = ["genvm-lint", action, "contracts/Recourse.py", *sys.argv[2:]]
    cli()


if __name__ == "__main__":
    main()
