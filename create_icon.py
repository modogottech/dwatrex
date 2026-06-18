#!/usr/bin/env python3
"""
Generate the Dwatrex application icon (.ico) programmatically.
Uses Pillow to create a professional factory-style icon in brand colors.
Run: pip install Pillow && python create_icon.py
"""
import math
import struct
import os

# Brand colors
BG_COLOR = (19, 19, 19)           # #131313 — surface
PRIMARY = (185, 199, 228)          # #b9c7e4 — steel blue
PRIMARY_CONTAINER = (10, 25, 47)   # #0a192f — deep navy
TERTIARY = (255, 183, 125)         # #ffb77d — electric orange
ON_SURFACE = (229, 226, 225)       # #e5e2e1

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))


def create_icon_without_pillow():
    """Create a .ico file using raw pixel manipulation (no dependencies)."""

    def make_bmp_icon(size):
        """Create a single BMP icon image at the given size."""
        pixels = [[BG_COLOR for _ in range(size)] for _ in range(size)]

        s = size  # shorthand
        cx, cy = s // 2, s // 2  # center

        # --- Draw rounded square background ---
        r = int(s * 0.12)  # corner radius
        for y in range(s):
            for x in range(s):
                margin = int(s * 0.06)
                ix, iy = x - margin, y - margin
                inner_w = s - 2 * margin
                inner_h = s - 2 * margin
                if ix < 0 or iy < 0 or ix >= inner_w or iy >= inner_h:
                    continue
                # Check rounded corners
                in_rect = True
                if ix < r and iy < r:
                    in_rect = math.hypot(ix - r, iy - r) <= r
                elif ix >= inner_w - r and iy < r:
                    in_rect = math.hypot(ix - (inner_w - r - 1), iy - r) <= r
                elif ix < r and iy >= inner_h - r:
                    in_rect = math.hypot(ix - r, iy - (inner_h - r - 1)) <= r
                elif ix >= inner_w - r and iy >= inner_h - r:
                    in_rect = math.hypot(ix - (inner_w - r - 1), iy - (inner_h - r - 1)) <= r
                if in_rect:
                    pixels[y][x] = PRIMARY_CONTAINER

        # --- Draw factory building ---
        # Main building body
        bld_left = int(s * 0.22)
        bld_right = int(s * 0.78)
        bld_top = int(s * 0.38)
        bld_bottom = int(s * 0.78)
        for y in range(bld_top, bld_bottom):
            for x in range(bld_left, bld_right):
                pixels[y][x] = PRIMARY

        # Chimney (left side)
        ch_left = int(s * 0.28)
        ch_right = int(s * 0.36)
        ch_top = int(s * 0.20)
        ch_bottom = bld_top
        for y in range(ch_top, ch_bottom):
            for x in range(ch_left, ch_right):
                pixels[y][x] = PRIMARY

        # Chimney 2 (right side, shorter)
        ch2_left = int(s * 0.56)
        ch2_right = int(s * 0.64)
        ch2_top = int(s * 0.28)
        ch2_bottom = bld_top
        for y in range(ch2_top, ch2_bottom):
            for x in range(ch2_left, ch2_right):
                pixels[y][x] = PRIMARY

        # --- Orange accent: roof line ---
        roof_y1 = bld_top - int(s * 0.02)
        roof_y2 = bld_top + int(s * 0.03)
        for y in range(roof_y1, roof_y2):
            for x in range(bld_left, bld_right):
                if 0 <= y < s:
                    pixels[y][x] = TERTIARY

        # --- Windows (dark cutouts) ---
        win_rows = [int(s * 0.48), int(s * 0.60)]
        win_cols = [int(s * 0.30), int(s * 0.44), int(s * 0.58)]
        win_size = max(int(s * 0.08), 2)
        for wy in win_rows:
            for wx in win_cols:
                for dy in range(win_size):
                    for dx in range(win_size):
                        py, px = wy + dy, wx + dx
                        if 0 <= py < s and 0 <= px < s:
                            pixels[py][px] = PRIMARY_CONTAINER

        # --- Door (orange accent at bottom center) ---
        door_w = max(int(s * 0.10), 2)
        door_h = max(int(s * 0.14), 3)
        door_left = cx - door_w // 2
        door_top = bld_bottom - door_h
        for y in range(door_top, bld_bottom):
            for x in range(door_left, door_left + door_w):
                if 0 <= y < s and 0 <= x < s:
                    pixels[y][x] = TERTIARY

        # --- Smoke puffs (small circles above chimneys) ---
        def draw_circle(cx, cy, radius, color):
            for y in range(max(0, cy - radius), min(s, cy + radius + 1)):
                for x in range(max(0, cx - radius), min(s, cx + radius + 1)):
                    if math.hypot(x - cx, y - cy) <= radius:
                        pixels[y][x] = color

        smoke_r = max(int(s * 0.03), 1)
        # Smoke from chimney 1
        draw_circle(int(s * 0.32), int(s * 0.16), smoke_r, (100, 100, 100))
        draw_circle(int(s * 0.30), int(s * 0.12), max(smoke_r - 1, 1), (80, 80, 80))

        return pixels

    def pixels_to_bmp_data(pixels, size):
        """Convert pixel array to BMP DIB data (bottom-up, BGRA)."""
        rows = []
        for y in range(size - 1, -1, -1):  # BMP is bottom-up
            row = b''
            for x in range(size):
                r, g, b = pixels[y][x]
                row += struct.pack('BBBB', b, g, r, 255)  # BGRA
            rows.append(row)
        return b''.join(rows)

    def create_ico_file(sizes, filepath):
        """Create a multi-size .ico file."""
        entries = []
        image_data_list = []

        for size in sizes:
            pixels = make_bmp_icon(size)
            pixel_data = pixels_to_bmp_data(pixels, size)

            # BMP info header (BITMAPINFOHEADER) — height is 2x for ICO format
            header = struct.pack('<IiiHHIIiiII',
                40,           # header size
                size,         # width
                size * 2,     # height (2x for ICO: image + mask)
                1,            # planes
                32,           # bits per pixel
                0,            # compression (none)
                len(pixel_data),  # image size
                0, 0,         # pixels per meter
                0, 0          # colors
            )

            # AND mask (all zeros = fully opaque since we use 32-bit BGRA)
            mask_row_size = ((size + 31) // 32) * 4
            mask_data = b'\x00' * mask_row_size * size

            bmp_data = header + pixel_data + mask_data
            image_data_list.append(bmp_data)

            # ICO directory entry
            w = size if size < 256 else 0
            h = size if size < 256 else 0
            entries.append((w, h, len(bmp_data)))

        # Write ICO file
        num = len(sizes)
        # ICO header: reserved(2) + type(2) + count(2) = 6 bytes
        ico_header = struct.pack('<HHH', 0, 1, num)

        # Calculate offsets
        dir_size = 16 * num
        offset = 6 + dir_size

        dir_entries = b''
        for i, (w, h, data_size) in enumerate(entries):
            dir_entries += struct.pack('<BBBBHHII',
                w, h,         # width, height (0 = 256)
                0,            # color palette
                0,            # reserved
                1,            # color planes
                32,           # bits per pixel
                data_size,    # size of image data
                offset        # offset from start of file
            )
            offset += data_size

        with open(filepath, 'wb') as f:
            f.write(ico_header)
            f.write(dir_entries)
            for data in image_data_list:
                f.write(data)

    # Generate multiple sizes
    sizes = [16, 32, 48, 64, 128, 256]
    ico_path = os.path.join(OUTPUT_DIR, 'dwatrex.ico')
    create_ico_file(sizes, ico_path)
    print(f"✅ Icon created: {ico_path}")
    print(f"   Sizes: {', '.join(str(s)+'x'+str(s) for s in sizes)}")
    return ico_path


if __name__ == '__main__':
    create_icon_without_pillow()
