"""
Extrae las bases de WhatsApp de una copia LOCAL del iPhone hecha en este PC.
Soporta copia SIN cifrar (copia directa por fileID) y CIFRADA (iphone_backup_decrypt).
Detecta automáticamente el dominio correcto — OJO: WhatsApp *Business* usa
'WhatsAppSMB', no 'WhatsApp'. Todo local; nada sale del equipo.

Uso:  python scripts/ios_extract.py            (sin cifrar, autodetecta)
      python scripts/ios_extract.py --password "..."   (si fuera cifrada)
"""
import argparse, os, sqlite3, glob, shutil

ROOTS = [os.path.expandvars(r"%USERPROFILE%\Apple\MobileSync\Backup"),
         os.path.expandvars(r"%APPDATA%\Apple Computer\MobileSync\Backup")]


def latest_backup():
    best = None
    for r in ROOTS:
        for e in glob.glob(os.path.join(r, "*")):
            man = os.path.join(e, "Manifest.db")
            if os.path.isfile(man):
                mt = os.path.getmtime(man)
                if not best or mt > best[0]:
                    best = (mt, e)
    return best[1] if best else None


def manifest_readable(backup):
    try:
        con = sqlite3.connect(f"file:{os.path.join(backup, 'Manifest.db')}?mode=ro", uri=True)
        con.execute("SELECT count(*) FROM Files").fetchone()
        return con
    except sqlite3.DatabaseError:
        return None


def pick_whatsapp_domain(con):
    """Elige el dominio de WhatsApp que SÍ contiene ChatStorage.sqlite (Business > normal)."""
    rows = con.execute(
        "SELECT DISTINCT domain FROM Files "
        "WHERE domain LIKE '%whatsapp%' AND relativePath = 'ChatStorage.sqlite'"
    ).fetchall()
    domains = [r[0] for r in rows]
    # Prioriza el de WhatsApp Business (SMB).
    for d in domains:
        if "SMB" in d:
            return d
    return domains[0] if domains else None


def copy_file(backup, con, domain, relpath, out):
    row = con.execute(
        "SELECT fileID FROM Files WHERE domain=? AND relativePath=?", (domain, relpath)
    ).fetchone()
    if not row:
        return False
    fid = row[0]
    candidates = [os.path.join(backup, fid[:2], fid), os.path.join(backup, fid)]
    src = next((c for c in candidates if os.path.isfile(c)), None)
    if not src:
        return False
    shutil.copy(src, out)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backup", default=None)
    ap.add_argument("--password", default=None, help="Solo si la copia es CIFRADA")
    ap.add_argument("--out-dir", default=os.path.join("data", "ios"))
    args = ap.parse_args()

    backup = args.backup or latest_backup()
    if not backup:
        raise SystemExit("[error] No hay copia local del iPhone en este PC.")
    os.makedirs(args.out_dir, exist_ok=True)
    print(f"[info] Copia: {backup}")

    con = manifest_readable(backup)
    if con:  # ---- SIN CIFRAR: copia directa ----
        domain = pick_whatsapp_domain(con)
        if not domain:
            raise SystemExit("[error] La copia no contiene ChatStorage.sqlite de WhatsApp.")
        print(f"[info] Dominio de WhatsApp: {domain}")
        chat_out = os.path.join(args.out_dir, "ChatStorage.sqlite")
        if copy_file(backup, con, domain, "ChatStorage.sqlite", chat_out):
            print(f"[ok] ChatStorage.sqlite → {chat_out} ({os.path.getsize(chat_out)} bytes)")
        else:
            raise SystemExit("[error] No pude copiar ChatStorage.sqlite.")
        cont_out = os.path.join(args.out_dir, "ContactsV2.sqlite")
        if copy_file(backup, con, domain, "ContactsV2.sqlite", cont_out):
            print(f"[ok] ContactsV2.sqlite → {cont_out}")
        else:
            print("[warn] Sin ContactsV2.sqlite (seguimos).")
    else:  # ---- CIFRADA: iphone_backup_decrypt ----
        if not args.password:
            raise SystemExit("[error] La copia está CIFRADA: pasa --password.")
        from iphone_backup_decrypt import EncryptedBackup, MatchFiles  # type: ignore
        eb = EncryptedBackup(backup_directory=backup, passphrase=args.password)
        # Extrae por dominio (WhatsAppSMB) — busca ChatStorage/ContactsV2 en cualquier dominio whatsapp.
        eb.extract_files(
            match=MatchFiles(domain_like="%whatsapp%", relative_paths_like="%ChatStorage.sqlite"),
            output_folder=args.out_dir,
            preserve_folders=False,
        )
        print("[ok] Extracción (cifrada) completada.")

    print("[listo] Bases de WhatsApp extraídas en", args.out_dir)


if __name__ == "__main__":
    main()
