#!/usr/bin/env python3
"""Build the corrected GhostBus poster + architecture diagram (PIL, exact text).

Corrections vs the AI-generated originals Ryan shared Nov 4, 2026:
- License is MIT, not Apache 2.0.
- GhostBus is not decentralized: one shared store / relay. The word is gone.
- No "distributed tracing" / "real-time telemetry": the bus shows a live
  board, presence + heartbeats, and an SSE event stream. Panels say that.
- Files are versioned (last 10 revisions kept), NOT content-addressed.
- The provenance log is append-only, not "immutable".
"""
import math, os, random
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.expanduser("~/workspace/ghostbus")
ART = os.path.join(ROOT, "docs/images/ghost-art.jpg")
FD = "/usr/share/fonts/truetype/dejavu"
def F(n, s): return ImageFont.truetype(f"{FD}/{n}.ttf", s)
B = lambda s: F("DejaVuSans-Bold", s)
R = lambda s: F("DejaVuSans", s)

BG = (10, 6, 24); PANEL = (19, 12, 40); EDGE = (122, 82, 224)
VIO = (167, 139, 250); VIO2 = (139, 92, 246); WHITE = (243, 240, 255)
MUT = (168, 158, 205); DIM = (120, 110, 165)

def bg(w, h, seed=7):
    im = Image.new("RGB", (w, h), BG)
    glow = Image.new("L", (w, h), 0)
    gd = ImageDraw.Draw(glow)
    gd.ellipse([w*0.45, -h*0.35, w*1.25, h*0.55], fill=70)
    glow = glow.resize((w//8, h//8)).resize((w, h))
    tint = Image.new("RGB", (w, h), (38, 20, 84))
    im = Image.composite(tint, im, glow.point(lambda v: v//2))
    d = ImageDraw.Draw(im, "RGBA")
    rnd = random.Random(seed)
    for _ in range(160):
        x, y = rnd.uniform(0, w), rnd.uniform(0, h)
        r = rnd.uniform(0.8, 2.2); a = rnd.randint(28, 110)
        d.ellipse([x-r, y-r, x+r, y+r], fill=(196, 181, 253, a))
    return im

def wrap(d, text, font, maxw):
    words, lines, cur = text.split(), [], ""
    for wd in words:
        t = (cur + " " + wd).strip()
        if d.textlength(t, font=font) <= maxw: cur = t
        else: lines.append(cur); cur = wd
    if cur: lines.append(cur)
    return lines

def rr(d, box, rad, **kw): d.rounded_rectangle(box, radius=rad, **kw)

def paste_art(im, box, fade_left=90, fade_top=0, fade_bottom=0, fade_right=0):
    """Paste ghost art into box (cover-crop) with soft edge fades."""
    art = Image.open(ART).convert("RGB")
    tw, th = box[2]-box[0], box[3]-box[1]
    sc = max(tw/art.width, th/art.height)
    art = art.resize((round(art.width*sc), round(art.height*sc)))
    x0 = (art.width-tw)//2; y0 = (art.height-th)//2
    art = art.crop((x0, y0, x0+tw, y0+th))
    mask = Image.new("L", (tw, th), 255)
    md = ImageDraw.Draw(mask)
    for x in range(min(fade_left, tw)):
        md.line([(x, 0), (x, th)], fill=int(255*x/fade_left))
    for x in range(min(fade_right, tw)):
        md.line([(tw-1-x, 0), (tw-1-x, th)], fill=int(255*x/fade_right))
    for y in range(min(fade_top, th)):
        md.line([(0, y), (tw, y)], fill=min(mask.getpixel((tw//2, y)), int(255*y/fade_top)))
    for y in range(min(fade_bottom, th)):
        md.line([(0, th-1-y), (tw, th-1-y)], fill=int(255*y/fade_bottom))
    im.paste(art, (box[0], box[1]), mask)
    return box

# ---------------------------------------------------------------- poster
def poster():
    W, H = 1920, 1280
    im = bg(W, H, seed=11)
    d = ImageDraw.Draw(im, "RGBA")
    # network motif: nodes + lines drifting to the ghost
    rnd = random.Random(4)
    nodes = [(rnd.uniform(1150, 1500), rnd.uniform(120, 1150)) for _ in range(9)]
    for (x, y) in nodes:
        d.line([(x, y), (1560, 640)], fill=(139, 92, 246, 60), width=2)
    for (x, y) in nodes:
        d.ellipse([x-5, y-5, x+5, y+5], fill=(196, 181, 253, 200))
    paste_art(im, (1252, 90, 1890, 1190), fade_left=170)
    x = 92
    # bus glyph
    rr(d, [x, 84, x+118, 168], 16, outline=VIO, width=5)
    d.rectangle([x+14, 104, x+104, 130], outline=VIO, width=4)
    for cx in (x+30, x+88):
        d.ellipse([cx-11, 146, cx+11, 168], outline=VIO, width=4)
    d.text((x+142, 78), "Ghost", font=B(104), fill=WHITE)
    gw = d.textlength("Ghost", font=B(104))
    d.text((x+142+gw, 78), "Bus", font=B(104), fill=VIO)
    d.text((x+146, 196), "A G E N T   M E S S A G E   B U S", font=B(31), fill=MUT)
    d.text((x, 268), "Open-source  •  Zero dependencies  •  Reliable  •  For agents, by developers", font=R(27), fill=(206, 196, 245))
    d.line([(x, 330), (1150, 330)], fill=(139, 92, 246, 160), width=2)
    hy = 372
    for line in ["Connect agents. Move messages.", "Build together."]:
        d.text((x, hy), line, font=B(57), fill=WHITE); hy += 76
    py = hy + 26
    for line in wrap(d, "GhostBus is a lightweight, shared message bus and workspace for agentic systems. Built for reliability, provenance, and open collaboration.", R(28), 1060):
        d.text((x, py), line, font=R(28), fill=MUT); py += 42
    # feature chips
    chips = [("ZERO", "DEPENDENCIES"), ("FAST &", "RELIABLE"), ("SECURE BY", "DESIGN"), ("OPEN", "SOURCE")]
    cx = x; cy = 838
    for i, (l1, l2) in enumerate(chips):
        gx = cx + i*272
        if i == 0:  # hexagon nodes
            pts = [(gx+34+30*math.cos(math.radians(a)), cy+44+30*math.sin(math.radians(a))) for a in range(0, 360, 60)]
            d.polygon(pts, outline=VIO, width=4)
            d.ellipse([gx+27, cy+37, gx+41, cy+51], fill=VIO)
        elif i == 1:  # lightning
            d.polygon([(gx+44, cy), (gx+18, cy+52), (gx+36, cy+52), (gx+26, cy+88), (gx+62, cy+32), (gx+42, cy+32), (gx+58, cy)], outline=VIO, width=4)
        elif i == 2:  # shield
            d.polygon([(gx+34, cy), (gx+64, cy+12), (gx+64, cy+44), (gx+34, cy+86), (gx+4, cy+44), (gx+4, cy+12)], outline=VIO, width=4)
            d.line([(gx+20, cy+40), (gx+30, cy+52), (gx+50, cy+26)], fill=VIO, width=5)
        else:  # </>
            d.text((gx+2, cy+6), "</>", font=B(52), fill=VIO)
        d.text((gx+2, cy+102), l1, font=B(24), fill=WHITE)
        d.text((gx+2, cy+132), l2, font=B(24), fill=WHITE)
    # footer
    rr(d, [x, 1122, 1150, 1196], 37, outline=VIO2, width=2)
    d.text((x+30, 1144), "</>", font=B(26), fill=VIO)
    d.text((x+96, 1146), "Open Source  •  MIT License  •  Built for the Agent Ecosystem", font=R(25), fill=(206, 196, 245))
    d.text((1252, 1216), "GhostBus Agent Message Bus · Ghost Developer Studio", font=R(23), fill=DIM)
    out = os.path.join(ROOT, "docs/images/poster.png")
    im.save(out); print("poster", im.size, os.path.getsize(out))

# ---------------------------------------------------------------- diagram
def panel(d, box, title, items):
    rr(d, box, 18, fill=PANEL, outline=EDGE, width=2)
    tf = B(23)
    while d.textlength(title, font=tf) > box[2]-box[0]-52 and tf.size > 15:
        tf = B(tf.size - 1)
    d.text((box[0]+26, box[1]+20), title, font=tf, fill=VIO)
    y = box[1] + 62
    for (t, s) in items:
        rr(d, [box[0]+18, y, box[2]-18, y+92], 12, fill=(26, 17, 56), outline=(74, 52, 140), width=1)
        d.text((box[0]+38, y+13), t, font=B(23), fill=WHITE)
        for j, line in enumerate(wrap(d, s, R(19), box[2]-box[0]-76)):
            d.text((box[0]+38, y+46+j*24), line, font=R(19), fill=MUT)
        y += 106

def agent_box(d, im, box, title, sub, glyph):
    rr(d, box, 16, fill=PANEL, outline=EDGE, width=2)
    gx, gy = box[0]+24, box[1]+24
    if glyph == "claude":
        for a in range(0, 180, 30):
            r = math.radians(a)
            d.line([(gx+22-20*math.cos(r), gy+22-20*math.sin(r)), (gx+22+20*math.cos(r), gy+22+20*math.sin(r))], fill=(217, 119, 87), width=5)
    elif glyph == "cursor":
        d.polygon([(gx+6, gy), (gx+40, gy+30), (gx+22, gy+32), (gx+30, gy+48), (gx+20, gy+52), (gx+12, gy+34), (gx, gy+44)], fill=(226, 232, 240))
    elif glyph == "bot":
        rr(d, [gx+2, gy+12, gx+42, gy+44], 8, outline=VIO, width=4)
        d.line([(gx+22, gy+12), (gx+22, gy+2)], fill=VIO, width=4)
        d.ellipse([gx+19, gy-2, gx+25, gy+4], fill=VIO)
        d.ellipse([gx+11, gy+24, gx+17, gy+30], fill=VIO); d.ellipse([gx+27, gy+24, gx+33, gy+30], fill=VIO)
    else:  # atom
        d.ellipse([gx+17, gy+17, gx+27, gy+27], fill=VIO)
        for a in (0, 60, 120):
            e = Image.new("RGBA", (60, 60), (0, 0, 0, 0))
            ed = ImageDraw.Draw(e); ed.ellipse([2, 18, 58, 42], outline=(167, 139, 250, 255), width=3)
            e = e.rotate(a, resample=Image.BICUBIC, center=(30, 30))
            im.paste(e, (gx-8, gy-8), e)
    d.text((box[0]+84, box[1]+18), title, font=B(30), fill=WHITE)
    d.text((box[0]+84, box[1]+56), sub, font=R(21), fill=MUT)

def arrow(d, p1, p2, color=(167, 139, 250, 220), width=3, dash=None):
    if dash:
        import math as m
        L = m.hypot(p2[0]-p1[0], p2[1]-p1[1]); n = int(L//dash)
        for i in range(n):
            t0, t1 = i/n, min(1, (i+0.55)/n)
            d.line([(p1[0]+(p2[0]-p1[0])*t0, p1[1]+(p2[1]-p1[1])*t0), (p1[0]+(p2[0]-p1[0])*t1, p1[1]+(p2[1]-p1[1])*t1)], fill=color, width=width)
    else:
        d.line([p1, p2], fill=color, width=width)
    ang = math.atan2(p2[1]-p1[1], p2[0]-p1[0])
    for s in (2.55, -2.55):
        d.line([p2, (p2[0]+16*math.cos(ang+s), p2[1]+16*math.sin(ang+s))], fill=color, width=width)

def diagram():
    W, H = 2000, 1500
    im = bg(W, H, seed=23)
    d = ImageDraw.Draw(im, "RGBA")
    # header
    art = Image.open(ART).convert("RGB").resize((86, 128))
    im.paste(art.crop((0, 10, 86, 96)), (46, 40))
    d.text((150, 44), "GhostBus", font=B(52), fill=WHITE)
    d.text((152, 108), "The AI agent communication and coordination fabric.", font=R(24), fill=MUT)
    # rings + center art
    C = (1000, 640)
    for r in (492, 442):
        d.ellipse([C[0]-r, C[1]-r, C[0]+r, C[1]+r], outline=(139, 92, 246, 90), width=2)
    paste_art(im, (742, 268, 1258, 1037), fade_left=40)
    d.rectangle([690, 1044, 1310, 1152], fill=BG)
    d.text((C[0]-d.textlength("GhostBus", font=B(46))/2, 1052), "GhostBus", font=B(46), fill=WHITE)
    sub = "Event Bus & Coordination Layer"
    d.text((C[0]-d.textlength(sub, font=R(23))/2, 1112), sub, font=R(23), fill=MUT)
    # agent boxes
    agent_box(d, im, (330, 196, 720, 306), "Claude", "AI Assistant Agent", "claude")
    agent_box(d, im, (1280, 196, 1670, 306), "Cursor", "Code Agent", "cursor")
    agent_box(d, im, (330, 1052, 720, 1162), "Custom Agent", "Specialized Agent", "bot")
    agent_box(d, im, (1280, 1052, 1670, 1162), "Custom Agent", "Automation Agent", "atom")
    # arrows (under panels is fine: drawn before panels)
    arrow(d, (700, 300), (760, 400)); arrow(d, (760, 430), (705, 330), dash=14)
    arrow(d, (1300, 300), (1240, 400)); arrow(d, (1240, 430), (1295, 330), dash=14)
    arrow(d, (700, 1060), (760, 950)); arrow(d, (755, 920), (700, 1030), dash=14)
    arrow(d, (1300, 1060), (1240, 950)); arrow(d, (1245, 920), (1300, 1030), dash=14)
    # side panels
    panel(d, (40, 470, 452, 756), "MESSAGING & COLLABORATION", [
        ("Chat & Context Messages", "Structured, typed messages"),
        ("Shared Files & Artifacts", "Versioned: last 10 revisions kept"),
    ])
    panel(d, (1548, 470, 1960, 928), "COORDINATION & TRUST", [
        ("Approvals & Guardrails", "A human approves sensitive actions"),
        ("Provenance & Audit Log", "Append-only record of actions & lineage"),
        ("Task Lifecycle & Status", "Track progress, dependencies, results"),
    ])
    arrow(d, (452, 600), (520, 600)); arrow(d, (520, 700), (452, 700), dash=12)
    lab = "PUBLISH / SUBSCRIBE"
    d.text((486-d.textlength(lab, font=B(14))/2, 722), lab, font=B(14), fill=DIM)
    arrow(d, (1480, 600), (1548, 600)); arrow(d, (1548, 700), (1480, 700), dash=12)
    lab = "COMMANDS & EVENTS"
    d.text((1514-d.textlength(lab, font=B(14))/2, 722), lab, font=B(14), fill=DIM)
    # bottom panel
    box = (560, 1216, 1440, 1352)
    rr(d, box, 18, fill=PANEL, outline=EDGE, width=2)
    t = "BUS ACTIVITY & PRESENCE"
    d.text((C[0]-d.textlength(t, font=B(23))/2, 1232), t, font=B(23), fill=VIO)
    cols = [("Presence & Heartbeats", "Who is online & available"),
            ("Live Board", "Agents, tasks & files, live"),
            ("Event Stream", "Live push over SSE")]
    cw = (1440-560-80)//3
    for i, (t1, s1) in enumerate(cols):
        bx = 600 + i*(cw+20)
        d.text((bx, 1272), t1, font=B(21), fill=WHITE)
        for j, line in enumerate(wrap(d, s1, R(18), cw-6)):
            d.text((bx, 1302+j*23), line, font=R(18), fill=MUT)
    # legend
    ly = 1408
    d.line([(640, ly+14), (730, ly+14)], fill=(167, 139, 250, 255), width=3)
    d.text((742, ly), "Messages & Commands", font=R(19), fill=MUT)
    arrow(d, (1010, ly+14), (1100, ly+14), dash=12)
    d.text((1112, ly), "Events & Push", font=R(19), fill=MUT)
    d.ellipse([1330, ly+4, 1350, ly+24], fill=VIO2)
    d.text((1362, ly), "GhostBus Event", font=R(19), fill=MUT)
    out = os.path.join(ROOT, "docs/images/architecture.png")
    im.save(out); print("diagram", im.size, os.path.getsize(out))

poster()
diagram()
