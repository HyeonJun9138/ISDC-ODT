"""Export slide 1 of a PPTX to PNG through PowerPoint (COM) for a visual check."""
import sys
from pathlib import Path

import win32com.client

src = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else src.with_suffix(".png")
# Attach to a PowerPoint the user already has open and never quit it; start (and later quit) a
# private instance only when none is running.
try:
    app = win32com.client.GetActiveObject("PowerPoint.Application")
    owned = False
except Exception:
    app = win32com.client.Dispatch("PowerPoint.Application")
    owned = True
pres = app.Presentations.Open(str(src), ReadOnly=True, Untitled=False, WithWindow=False)
try:
    pres.Slides(1).Export(str(out), "PNG", 1920, 1080)
    print("exported", out, out.stat().st_size, "bytes; shapes:", pres.Slides(1).Shapes.Count)
finally:
    pres.Close()
    if owned:
        app.Quit()
