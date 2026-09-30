"""Export every slide of a PPTX to PNG through PowerPoint (COM) and build a contact sheet."""
import sys
from pathlib import Path

import win32com.client
from PIL import Image, ImageDraw

src = Path(sys.argv[1]).resolve()
out_dir = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else src.parent / (src.stem + "_slides")
out_dir.mkdir(parents=True, exist_ok=True)
# Attach to a PowerPoint the user already has open and never quit it; start (and later quit) a
# private instance only when none is running.
try:
    app = win32com.client.GetActiveObject("PowerPoint.Application")
    owned = False
except Exception:
    app = win32com.client.Dispatch("PowerPoint.Application")
    owned = True
pres = app.Presentations.Open(str(src), ReadOnly=True, Untitled=False, WithWindow=False)
paths = []
try:
    for index in range(1, pres.Slides.Count + 1):
        path = out_dir / f"slide_{index:02d}.png"
        pres.Slides(index).Export(str(path), "PNG", 1600, 900)
        paths.append(path)
    if "--pdf" in sys.argv:
        pdf = src.with_suffix(".pdf")
        pres.SaveAs(str(pdf), 32)  # ppSaveAsPDF
        print("pdf", pdf, pdf.stat().st_size, "bytes")
finally:
    pres.Close()
    if owned:
        app.Quit()
cols, tw, th = 3, 600, 338
rows = (len(paths) + cols - 1) // cols
sheet = Image.new("RGB", (cols * (tw + 10) + 10, rows * (th + 24) + 10), "white")
draw = ImageDraw.Draw(sheet)
for i, path in enumerate(paths):
    im = Image.open(path).convert("RGB")
    im.thumbnail((tw, th))
    x = 10 + (i % cols) * (tw + 10)
    y = 10 + (i // cols) * (th + 24)
    sheet.paste(im, (x, y))
    draw.text((x, y + th + 4), path.name, fill="black")
sheet_path = out_dir / "contact_sheet.png"
sheet.save(sheet_path)
print("exported", len(paths), "slides to", out_dir, "; sheet", sheet_path, sheet.size)
