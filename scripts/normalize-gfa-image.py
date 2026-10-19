"""Normalize a GFA screenshot from stdin to bounded JPEG bytes on stdout."""

import io
import sys

from PIL import Image, ImageOps


def main():
    source = sys.stdin.buffer.read(6 * 1024 * 1024 + 1)
    if not source or len(source) > 6 * 1024 * 1024:
        raise ValueError("invalid_image_size")
    with Image.open(io.BytesIO(source)) as image:
        image = ImageOps.exif_transpose(image)
        if image.width < 32 or image.height < 32 or image.width * image.height > 20_000_000:
            raise ValueError("invalid_image_dimensions")
        image = image.convert("RGB")
        image.thumbnail((1280, 720), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=88, optimize=True)
    sys.stdout.buffer.write(output.getvalue())


if __name__ == "__main__":
    main()
