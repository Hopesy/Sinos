import sys
from pathlib import Path
import shutil

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1]).expanduser() if len(sys.argv) > 1 else ROOT / "branding" / "sinos"
BRANDING = ROOT / "branding" / "sinos"
ICONS = ROOT / "icons"
PUBLIC = ROOT / "src-ui" / "public"
UI_ASSETS = ROOT / "src-ui" / "src" / "assets"


def copy_branding_assets() -> None:
    if not SOURCE.is_dir():
        raise SystemExit(f"Sinos asset directory does not exist: {SOURCE}")
    BRANDING.mkdir(parents=True, exist_ok=True)
    for source in SOURCE.iterdir():
        if source.is_file():
            target = BRANDING / source.name
            if source.resolve() != target.resolve():
                shutil.copy2(source, target)


def save_png(image: Image.Image, size: int, target: Path) -> None:
    resized = image.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(target, format="PNG", optimize=True)


def generate_app_icons() -> None:
    source = Image.open(SOURCE / "sinos-icon.png").convert("RGBA")
    sizes = {
        "32x32.png": 32,
        "64x64.png": 64,
        "128x128.png": 128,
        "128x128@2x.png": 256,
        "256x256.png": 256,
        "512x512.png": 512,
        "icon.png": 512,
        "icon-source-unix.png": 1024,
        "icon-source-windows.png": 1024,
    }
    for name, size in sizes.items():
        save_png(source, size, ICONS / name)

    source.save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    source.save(ICONS / "icon.icns", format="ICNS")

    rounded = Image.open(SOURCE / "sinos-icon-rounded-white.png").convert("RGBA")
    rounded.save(ICONS / "icon-rounded.png", format="PNG", optimize=True)


def copy_web_assets() -> None:
    shutil.copy2(SOURCE / "sinos-icon.svg", PUBLIC / "favicon.svg")
    shutil.copy2(SOURCE / "sinos-icon.svg", PUBLIC / "sinos-icon.svg")
    UI_ASSETS.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SOURCE / "sinos-icon.svg", UI_ASSETS / "sinos-icon.svg")
    shutil.copy2(SOURCE / "sinos-icon-dark.png", PUBLIC / "sinos-icon-dark.png")
    shutil.copy2(SOURCE / "sinos-wordmark.svg", PUBLIC / "sinos-wordmark.svg")
    shutil.copy2(SOURCE / "sinos-wordmark-dark.png", PUBLIC / "sinos-wordmark-dark.png")


copy_branding_assets()
generate_app_icons()
copy_web_assets()
