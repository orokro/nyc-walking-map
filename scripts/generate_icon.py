import os
import struct
import zlib

os.makedirs('build', exist_ok=True)
w, h = 256, 256
pixels = bytearray(w * h * 4)
pts = [(48, 196), (92, 140), (84, 88), (144, 116), (168, 60), (208, 96)]

for y in range(h):
    for x in range(w):
        idx = (y * w + x) * 4
        dx = max(0.0, abs(x - 127.5) - 96.0)
        dy = max(0.0, abs(y - 127.5) - 96.0)
        dist_corner = (dx * dx + dy * dy) ** 0.5
        if dist_corner > 28.0:
            pixels[idx : idx + 4] = b'\x00\x00\x00\x00'
            continue
        r = int(11 + (y / h) * 14)
        g = int(20 + (y / h) * 22)
        b = int(38 + (y / h) * 32)
        min_d = 999.0
        for i in range(len(pts) - 1):
            x1, y1 = pts[i]
            x2, y2 = pts[i + 1]
            vx, vy = x2 - x1, y2 - y1
            wx, wy = x - x1, y - y1
            c1 = vx * wx + vy * wy
            c2 = vx * vx + vy * vy
            t = max(0.0, min(1.0, c1 / c2 if c2 else 0.0))
            px, py = x1 + t * vx, y1 + t * vy
            d = ((x - px) ** 2 + (y - py) ** 2) ** 0.5
            if d < min_d:
                min_d = d
        d_start = ((x - pts[0][0]) ** 2 + (y - pts[0][1]) ** 2) ** 0.5
        d_end = ((x - pts[-1][0]) ** 2 + (y - pts[-1][1]) ** 2) ** 0.5
        if d_start < 13:
            r, g, b = 34, 197, 94
        elif d_end < 14:
            r, g, b = 249, 115, 22
        elif min_d < 8.5:
            r, g, b = 56, 189, 248
        elif min_d < 16:
            glow = (16 - min_d) / 7.5
            r = int(r * (1 - glow * 0.5) + 14 * glow * 0.5)
            g = int(g * (1 - glow * 0.5) + 165 * glow * 0.5)
            b = int(b * (1 - glow * 0.5) + 233 * glow * 0.5)
        pixels[idx : idx + 4] = bytes([r, g, b, 255])

def make_png(w, h, rgba):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw.extend(rgba[y * w * 4 : (y + 1) * w * 4])

    def chunk(tag, data):
        return (
            struct.pack('>I', len(data))
            + tag
            + data
            + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
        + chunk(b'IEND', b'')
    )

png_bytes = make_png(w, h, pixels)
open('build/icon.png', 'wb').write(png_bytes)
ico_hdr = struct.pack('<HHHBBBBHHII', 0, 1, 1, 0, 0, 0, 0, 1, 32, len(png_bytes), 22)
open('build/icon.ico', 'wb').write(ico_hdr + png_bytes)
print('Generated build/icon.png and build/icon.ico:', len(png_bytes), 'bytes')
