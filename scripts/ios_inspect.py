"""Inspecciona ChatStorage.sqlite (Core Data de WhatsApp iOS): tablas, columnas,
recuentos y rango de fechas. Solo lectura. Núcleo Core Data: fechas = segundos
desde 2001-01-01 (unix = valor + 978307200)."""
import sqlite3, os, datetime

APPLE_EPOCH = 978307200
DB = os.path.join("data", "ios", "ChatStorage.sqlite")
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

def cols(table):
    return [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]

def when(v):
    if v is None: return "—"
    try: return datetime.datetime.utcfromtimestamp(v + APPLE_EPOCH).strftime("%Y-%m-%d")
    except Exception: return f"?{v}"

tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
print("TABLAS:", ", ".join(t for t in tables if t.startswith("ZWA")))

for t in ("ZWAMESSAGE", "ZWACHATSESSION", "ZWAMEDIAITEM"):
    if t in tables:
        n = con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
        print(f"\n== {t} == filas={n}")
        print("  columnas:", ", ".join(cols(t)))

# Rango de fechas de los mensajes
mcols = cols("ZWAMESSAGE")
datecol = "ZMESSAGEDATE" if "ZMESSAGEDATE" in mcols else next((c for c in mcols if "DATE" in c), None)
if datecol:
    lo, hi = con.execute(f"SELECT min({datecol}), max({datecol}) FROM ZWAMESSAGE").fetchone()
    print(f"\nRango de mensajes ({datecol}): {when(lo)}  →  {when(hi)}")
    y2025 = con.execute(
        f"SELECT count(*) FROM ZWAMESSAGE WHERE {datecol} >= ?",
        (datetime.datetime(2025,1,1).timestamp() - APPLE_EPOCH,)
    ).fetchone()[0]
    print(f"Mensajes desde 2025-01-01: {y2025}")

# Muestra de sesiones (chats) con nombre/JID
scols = cols("ZWACHATSESSION")
namecol = next((c for c in scols if c in ("ZPARTNERNAME","ZDISPLAYNAME")), None)
jidcol = next((c for c in scols if c in ("ZCONTACTJID","ZCONTACTIDENTIFIER")), None)
nchats = con.execute("SELECT count(*) FROM ZWACHATSESSION").fetchone()[0]
print(f"\nCHATS (ZWACHATSESSION): {nchats}")
if namecol and jidcol:
    rows = con.execute(f"SELECT {namecol}, {jidcol} FROM ZWACHATSESSION LIMIT 8").fetchall()
    for nm, jid in rows:
        print(f"   - {nm!r:30} {jid}")
