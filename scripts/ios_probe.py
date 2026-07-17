"""Sondea una copia local de iPhone: ¿cifrada? ¿contiene la base de WhatsApp?"""
import sqlite3, os, glob

ROOTS = [os.path.expandvars(r"%USERPROFILE%\Apple\MobileSync\Backup"),
         os.path.expandvars(r"%APPDATA%\Apple Computer\MobileSync\Backup")]

def latest():
    best = None
    for r in ROOTS:
        for e in glob.glob(os.path.join(r, "*")):
            man = os.path.join(e, "Manifest.db")
            if os.path.isfile(man):
                mt = os.path.getmtime(man)
                if not best or mt > best[0]:
                    best = (mt, e)
    return best[1] if best else None

b = latest()
print("Backup:", b)
if not b:
    raise SystemExit("No hay copia local.")

man = os.path.join(b, "Manifest.db")
try:
    con = sqlite3.connect(f"file:{man}?mode=ro", uri=True)
    total = con.execute("SELECT count(*) FROM Files").fetchone()[0]
    print(f"=> Manifest.db LEGIBLE (copia SIN cifrar). Ficheros: {total}")
    wc = con.execute("SELECT count(*) FROM Files WHERE domain LIKE '%whatsapp%'").fetchone()[0]
    print(f"   Ficheros de WhatsApp en la copia: {wc}")
    rows = con.execute(
        "SELECT domain, relativePath FROM Files "
        "WHERE domain LIKE '%whatsapp%' AND "
        "(relativePath LIKE '%ChatStorage.sqlite' OR relativePath LIKE '%ContactsV2.sqlite')"
    ).fetchall()
    print("   Bases clave encontradas:")
    for d, rp in rows:
        print(f"     - {d} :: {rp}")
    if not rows:
        print("   ⚠️ NO está ChatStorage.sqlite → hará falta copia CIFRADA.")
except sqlite3.DatabaseError as e:
    print(f"=> Manifest.db NO legible → copia CIFRADA. ({e})")
    print("   Usaré iphone_backup_decrypt con la contraseña guardada.")
