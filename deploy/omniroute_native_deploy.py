#!/usr/bin/env python3
"""Installation durable de l'adaptateur Paperclip `omniroute_native` (lot 14).

Installe l'artefact AUTONOME (voir deploy/build-artifact.sh) dans un chemin
dédié, hors de tout dépôt git :

    /paperclip/adapter-plugins/omniroute-native/
        releases/<AAAAMMJJ-HHMMSS>-<sha7>/   une version par installation, côte à côte
        current -> releases/<…>              lien basculé atomiquement (rename)

et pointe le registre Paperclip (`/paperclip/adapter-plugins.json`) sur
`…/omniroute-native/current`. Le registre ne change donc qu'une fois ; les mises
à jour suivantes ne font que basculer `current`.

Modes (un seul à la fois) :
  --dry-run   (défaut) lecture seule en production. Relit l'état, compte les runs
              actifs, puis charge l'artefact avec le VRAI chargeur Paperclip dans
              le conteneur, sur une copie sous --container-tmp (supprimée ensuite).
  --apply     contrôles avant → sauvegarde sur l'hôte distant → copie de la version
              → bascule de `current` → registre réécrit atomiquement (temporaire +
              rename, après contrôle d'empreinte) → `docker restart paperclip` →
              contrôles après. Toute erreur après la bascule de `current` (registre,
              redémarrage, API non saine, contrôles) : retour arrière automatique
              (sauf --no-auto-rollback).
  --rollback  restaure le registre et `current` du dernier état sauvegardé (ou
              --state), redémarre, contrôle.

Pourquoi un redémarrage et pas `POST /api/adapters/omniroute_native/reload` :
le serveur garde le registre EN MÉMOIRE (adapter-plugin-store.ts, storeCache).
Après réécriture du fichier, la route de rechargement relirait l'ANCIEN chemin et
réécrirait le fichier avec l'ancien enregistrement (addAdapterPlugin). Elle exige
aussi un compte administrateur d'instance. Et même sans changer le registre, une
bascule de `current` suivie d'un rechargement réimporte l'ANCIENNE version : le
résolveur ESM de Node garde en cache le chemin réel du lien (mesuré, essai à blanc
S5). Voir deploy/README.md.

Aucun secret n'est lu ni affiché : DATABASE_URL et les clés restent dans le
conteneur (développés par le shell du conteneur, jamais imprimés).
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
import pathlib
import posixpath
import re
import shlex
import subprocess
import sys
import tarfile
import time

ADAPTER_TYPE = "omniroute_native"
HOST = os.environ.get("PAPERCLIP_SSH_HOST", "root@localhost")
CONTAINER = "paperclip"
CT_HOME = "/paperclip"                       # PAPERCLIP_HOME dans le conteneur
HOST_HOME = os.environ.get("PAPERCLIP_HOST_HOME", "/var/lib/paperclip")
BACKUP_ROOT = os.environ.get("PAPERCLIP_BACKUP_ROOT", "/var/backups/paperclip")
INSTALL_REL = "adapter-plugins/omniroute-native"
REGISTRY_REL = "adapter-plugins.json"
HEALTH_URL = "http://127.0.0.1:3100/api/health"
TSX_LOADER = "./server/node_modules/tsx/dist/loader.mjs"
HERE = pathlib.Path(__file__).resolve().parent
ACTIVE_RUNS_SQL = ("select count(*) from heartbeat_runs "
                   "where status in ('running','queued','starting')")


# ─── Fonctions pures (testées par deploy/tests/test_deploy.py) ──────────────

def new_registry(records, adapter_type, local_path, version, installed_at):
    """Registre identique, sauf l'entrée `adapter_type` (remplacée ou ajoutée)."""
    if not isinstance(records, list):
        raise ValueError("adapter-plugins.json n'est pas une liste")
    entry = {"packageName": local_path, "localPath": local_path, "version": version,
             "type": adapter_type, "installedAt": installed_at}
    out, seen = [], False
    for rec in records:
        if isinstance(rec, dict) and rec.get("type") == adapter_type:
            if not seen:
                out.append(entry)
            seen = True
        else:
            out.append(rec)
    if not seen:
        out.append(entry)
    return out


def serialize_registry(records):
    """Même forme que Paperclip : JSON.stringify(records, null, 2)."""
    return json.dumps(records, indent=2, ensure_ascii=False)


def parse_loader_logs(text):
    """Extrait des journaux pino du serveur ce que le chargeur a fait."""
    info = {"package_dirs": [], "loaded_types": [], "failures": []}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        msg = rec.get("msg", "")
        if msg == "Loading external adapter package":
            info["package_dirs"].append(rec.get("packageDir"))
        elif msg == "Loaded external adapters from plugin store":
            info["loaded_types"].extend(rec.get("adapters") or [])
        elif msg.startswith("Failed to dynamically load external adapter"):
            info["failures"].append(rec.get("packageName") or rec.get("type") or "?")
    return info


def post_check_errors(info, adapter_type, expected_dir):
    errs = []
    if info["failures"]:
        errs.append("journal « Failed to dynamically load external adapter » : "
                    + ", ".join(map(str, info["failures"])))
    if adapter_type not in info["loaded_types"]:
        errs.append(f"{adapter_type} absent de « Loaded external adapters » : "
                    "les agents retomberaient sur l'adaptateur process")
    if expected_dir not in info["package_dirs"]:
        errs.append(f"aucun chargement depuis {expected_dir} (vus : {info['package_dirs']})")
    return errs


def catalogue_degraded(cat):
    """Les 6 combos codés en dur au lieu du catalogue réel (models.ts, repli)."""
    return bool(cat) and cat.get("count", 0) <= 6 and cat.get("ms", 0) >= 8000


def content_digest(tar_bytes, root="omniroute-native"):
    """SHA-256 du manifeste `sha256sum` trié des fichiers (= CONTENT_SHA256 de build-artifact.sh)."""
    lines = []
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as tf:
        for m in tf.getmembers():
            if m.isfile():
                f = tf.extractfile(m)
                data = f.read() if f else b""
                lines.append((("./" + m.name[len(root) + 1:]).encode(),
                              hashlib.sha256(data).hexdigest()))
    lines.sort(key=lambda x: x[0])
    manifest = b"".join(h.encode() + b"  " + name + b"\n" for name, h in lines)
    return hashlib.sha256(manifest).hexdigest()


def release_id(stamp, git_sha):
    return f"{stamp}-{git_sha[:7]}"


def parse_active_runs(output):
    text = output.strip()
    if not re.fullmatch(r"\d+", text):
        raise ValueError(f"comptage des runs illisible : {text[:120]!r}")
    return int(text)


def latest_state(names):
    states = sorted(n for n in names
                    if re.fullmatch(r"omniroute-native-lot14-\d{8}-\d{6}\.state\.json", n))
    return states[-1] if states else None


SAFE_PATH = re.compile(r"/[A-Za-z0-9/_.-]*")


def check_safe_path(path, what="chemin"):
    """Chemin absolu limité à [A-Za-z0-9/_.-] : sûr dans une commande shell."""
    if not isinstance(path, str) or not SAFE_PATH.fullmatch(path):
        raise ValueError(f"{what} : caractères autorisés [A-Za-z0-9/_.-] seulement : {path!r}")
    return path


def check_container_tmp(path):
    check_safe_path(path, "--container-tmp")
    norm = posixpath.normpath(path)
    if not norm.startswith("/tmp/") or norm != path.rstrip("/"):
        raise ValueError(f"--container-tmp doit être sous /tmp/ : {path}")
    return norm


def now_stamp():
    return time.strftime("%Y%m%d-%H%M%S")


def parse_args(argv):
    p = argparse.ArgumentParser(description=(__doc__ or "").split("\n")[0])
    mode = p.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", dest="mode", action="store_const", const="dry-run")
    mode.add_argument("--apply", dest="mode", action="store_const", const="apply")
    mode.add_argument("--rollback", dest="mode", action="store_const", const="rollback")
    mode.add_argument("--check", dest="mode", action="store_const", const="check",
                      help="lecture seule : le serveur en service a-t-il chargé l'adaptateur ?")
    p.set_defaults(mode="dry-run")
    p.add_argument("--artifact", help="omniroute-native-<sha7>.tar.gz (défaut : construit)")
    p.add_argument("--host", default=HOST)
    p.add_argument("--container", default=CONTAINER)
    p.add_argument("--container-tmp", default="/tmp/omniroute-native-dryrun",
                   help="préfixe des copies jetables dans le conteneur (sous /tmp/)")
    p.add_argument("--state", help="--rollback : nom du fichier d'état (défaut : le dernier)")
    p.add_argument("--no-auto-rollback", action="store_true")
    p.add_argument("--allow-dirty", action="store_true",
                   help="accepter un artefact construit avec des modifications non commitées")
    p.add_argument("--ignore-active-runs", action="store_true",
                   help="--rollback seulement : ne pas attendre la fin des runs")
    p.add_argument("--skip-catalogue", action="store_true")
    p.add_argument("--report", help="écrire le compte rendu JSON dans ce fichier")
    p.add_argument("--sandbox", metavar="/tmp/DOSSIER",
                   help="essai à blanc de --apply/--rollback/--check dans un bac à sable sous "
                        "/tmp du conteneur (vrai chargeur, aucun redémarrage ; voir SandboxRemote)")
    return p.parse_args(argv)


# ─── Accès distant ──────────────────────────────────────────────────────────

class Remote:
    """Accès au serveur : `ssh` sur l'hôte distant, `ct` dans le conteneur.

    Les racines (`ct_home` = PAPERCLIP_HOME vu du conteneur, `host_home` = le même
    dossier vu de l'hôte, `backup_root` = sauvegardes) sont paramétrables : les tests
    et le bac à sable (--sandbox) les redirigent vers un dossier jetable.
    """

    def __init__(self, host, container, tmp_prefix="/tmp/omniroute-native-dryrun", *,
                 ct_home=CT_HOME, host_home=HOST_HOME, backup_root=BACKUP_ROOT):
        self.host_name, self.container = host, container
        self.tmp_prefix = check_safe_path(tmp_prefix, "tmp_prefix")
        self.ct_home = check_safe_path(ct_home, "ct_home")
        self.host_home = check_safe_path(host_home, "host_home")
        self.backup_root = check_safe_path(backup_root, "backup_root")

    def ssh(self, cmd, *, input_bytes=None, check=True, timeout=300):
        r = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                            self.host_name, cmd], input=input_bytes, capture_output=True,
                           timeout=timeout)
        if check and r.returncode:
            raise RuntimeError(f"échec distant ({r.returncode}) : {cmd[:160]}\n"
                               + (r.stdout + r.stderr).decode("utf-8", "replace")[-1500:])
        return r

    def ct(self, script, *, user="node", input_bytes=None, check=True, timeout=300):
        """Script sh dans le conteneur (stdin transmis grâce à -i)."""
        cmd = (f"docker exec -i -u {user} {self.container} sh -c "
               + shlex.quote(script))
        return self.ssh(cmd, input_bytes=input_bytes, check=check, timeout=timeout)

    def out(self, r):
        return r.stdout.decode("utf-8", "replace")

    # Opérations nommées (remplacées par des bouchons dans les tests et le bac à sable).
    def host(self, cmd, *, input_bytes=None, check=True, timeout=300):
        """Commande sur les fichiers côté hôte (sauvegardes, état, restauration)."""
        return self.ssh(cmd, input_bytes=input_bytes, check=check, timeout=timeout)

    def utc_now(self):
        return self.out(self.ssh("date -u +%Y-%m-%dT%H:%M:%SZ")).strip()

    def started_at(self):
        return self.out(self.ssh(f"docker inspect -f '{{{{.State.StartedAt}}}}' {self.container}")).strip()

    def restart(self):
        self.ssh(f"docker restart {self.container}", timeout=240)

    def server_logs(self, since):
        return self.out(self.ssh(f"docker logs --since {since} {self.container} 2>&1", timeout=120))

    def health(self):
        return self.out(self.ct(f"curl -s -o /dev/null -w '%{{http_code}}' {HEALTH_URL}",
                                check=False, timeout=30)).strip()

    def active_runs_raw(self):
        return self.out(self.ct(
            "PGOPTIONS='-c default_transaction_read_only=on' psql \"$DATABASE_URL\" -Atc "
            + shlex.quote(ACTIVE_RUNS_SQL), check=False))


class SandboxRemote(Remote):
    """--sandbox <dossier sous /tmp> : --apply / --rollback / --check À BLANC, avec le VRAI
    chargeur Paperclip, dans un bac à sable DANS le conteneur.

    PAPERCLIP_HOME = <dossier>/home (à préparer : adapter-plugins.json + installation),
    sauvegardes = <dossier>/backups. Toutes les écritures restent sous <dossier>.
    Différences avec la production, et seulement celles-ci :
      - « hôte » = le conteneur (utilisateur node), sous <dossier> ;
      - Paperclip n'est PAS redémarré : le « redémarrage » lance un processus Node neuf
        qui importe le chargeur du serveur (real-loader-probe.mjs) sur le registre du bac à
        sable, comme le serveur à son démarrage ; ses journaux tiennent lieu de
        `docker logs` ; la santé vaut 200 si ce processus a rendu un résultat ;
      - runs actifs : 0 (le bac à sable n'en a pas).
    """

    FORBIDDEN = re.compile(r"(?<![\w.-])/(?:paperclip|mnt)(?:/|\b)"
                           r"|docker\s+(?:restart|stop|start|kill|rm|cp)\b")

    def __init__(self, host, container, root):
        root = check_container_tmp(root)
        super().__init__(host, container, f"{root}/sonde", ct_home=f"{root}/home",
                         host_home=f"{root}/home", backup_root=f"{root}/backups")
        self.root, self._logs, self.last_start = root, None, None

    def ssh(self, cmd, **kw):
        if self.FORBIDDEN.search(cmd):
            raise RuntimeError(f"bac à sable : commande refusée : {cmd[:200]}")
        return super().ssh(cmd, **kw)

    def host(self, cmd, **kw):
        return self.ct(cmd, **kw)

    def active_runs_raw(self):
        return "0"

    def health(self):
        if self.last_start is None:
            return "200"
        return "200" if "effectiveAdapterType" in self.last_start else "000"

    def restart(self):
        log("   (bac à sable : pas de docker restart ; nouveau processus avec le vrai chargeur)")
        r = run_probe(self, self.ct_home, catalogue=False, forbid=None)
        self.last_start = r
        info = r["loaderLogs"]
        lines = [{"msg": "Loading external adapter package", "packageDir": d}
                 for d in info["package_dirs"]]
        if info["loaded_types"]:
            lines.append({"msg": "Loaded external adapters from plugin store",
                          "adapters": info["loaded_types"]})
        lines += [{"msg": "Failed to dynamically load external adapter; skipping",
                   "packageName": f} for f in info["failures"]]
        self._logs = "\n".join(json.dumps(x) for x in lines)

    def server_logs(self, since):
        if self._logs is None:      # --check : « le serveur tel qu'il démarrerait maintenant »
            self.restart()
        return self._logs


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def log(msg):
    print(msg, flush=True)


# ─── Artefact ───────────────────────────────────────────────────────────────

def _member(tf, name):
    f = tf.extractfile(name)
    if f is None:
        raise SystemExit(f"{name} absent de l'archive")
    return f.read()


def ensure_artifact(path):
    if path:
        art = pathlib.Path(path).resolve()
    else:
        log("== construction de l'artefact (deploy/build-artifact.sh)")
        out = subprocess.run([str(HERE / "build-artifact.sh")], capture_output=True,
                             text=True, check=True).stdout
        m = re.search(r"^ARTIFACT (.+)$", out, re.M)
        if not m:
            raise SystemExit("build-artifact.sh n'a pas annoncé d'artefact")
        art = pathlib.Path(m.group(1))
    data = art.read_bytes()
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tf:
        names = tf.getnames()
        info = json.loads(_member(tf, "omniroute-native/BUILD-INFO.json"))
        pkg = json.loads(_member(tf, "omniroute-native/package.json"))
    bad = [n for n in names if not (n == "omniroute-native" or n.startswith("omniroute-native/"))
           or ".." in n.split("/")]
    if bad:
        raise SystemExit(f"archive suspecte : {bad[:3]}")
    return {"path": str(art), "bytes": data, "sha256": sha256_bytes(data),
            "contentSha256": content_digest(data),
            "members": len(names), "build": info, "version": pkg.get("version", "0.0.0")}


# ─── État de la production (lecture seule) ──────────────────────────────────

def read_state(rm):
    reg_path = f"{rm.ct_home}/{REGISTRY_REL}"
    raw = rm.ct(f"cat {reg_path}").stdout
    records = json.loads(raw.decode("utf-8"))
    rec = next((r for r in records if r.get("type") == ADAPTER_TYPE), None)
    local = rec.get("localPath") if rec else None
    exists = None
    if local:
        exists = rm.ct(f"test -e {shlex.quote(local)}", check=False).returncode == 0
    install = f"{rm.ct_home}/{INSTALL_REL}"
    current = rm.out(rm.ct(f"readlink {install}/current", check=False)).strip() or None
    releases = rm.out(rm.ct(f"ls -1 {install}/releases 2>/dev/null", check=False)).split()
    runs_raw = rm.active_runs_raw().strip()
    try:
        active_runs = parse_active_runs(runs_raw)
    except ValueError as exc:
        active_runs, runs_raw = None, str(exc)
    health = rm.health()
    started = rm.started_at()
    return {"registry_path": reg_path, "registry_raw": raw, "registry_sha256": sha256_bytes(raw), "records": records,
            "record": rec, "localPath": local, "localPathExists": exists,
            "current": current, "releases": releases, "active_runs": active_runs,
            "active_runs_raw": runs_raw if active_runs is None else None,
            "health": health, "startedAt": started}


def print_state(st):
    log(f"   registre        : {st['registry_path']} sha256={st['registry_sha256'][:16]}… "
        f"({len(st['records'])} entrée(s))")
    log(f"   localPath actuel: {st['localPath']} (existe={st['localPathExists']})")
    log(f"   {INSTALL_REL}: current={st['current']} releases={st['releases']}")
    log(f"   runs actifs     : {st['active_runs']}"
        + (f" ({st['active_runs_raw']})" if st['active_runs_raw'] else ""))
    log(f"   santé API       : HTTP {st['health']} — conteneur démarré {st['startedAt']}")


# ─── Sonde du vrai chargeur ─────────────────────────────────────────────────

def run_probe(rm, home, *, expect_dir=None, catalogue=True, allow_real_home=False, extra=None,
              forbid="agency-starter"):
    """Copie la sonde dans /tmp du conteneur et l'exécute avec le chargeur du serveur."""
    probe = (HERE / "real-loader-probe.mjs").read_bytes()
    stamp = f"{int(time.time() * 1000)}"
    probe_path = f"{rm.tmp_prefix}-probe-{stamp}.mjs"
    env = {"PAPERCLIP_HOME": home, "PROBE_TYPE": ADAPTER_TYPE}
    if forbid:
        env["PROBE_FORBID"] = forbid
    if expect_dir:
        env["PROBE_EXPECT_DIR"] = expect_dir
    if catalogue:
        env["PROBE_CATALOGUE"] = "1"
    if allow_real_home:
        env["PROBE_ALLOW_REAL_HOME"] = "1"
    env.update(extra or {})
    envs = " ".join(f"{k}={shlex.quote(v)}" for k, v in env.items())
    q = shlex.quote(probe_path)
    script = (f"cat > {q} && cd /app && env {envs} node --import {TSX_LOADER} "
              f"{q}; rc=$?; rm -f {q}; exit $rc")
    r = rm.ct(script, input_bytes=probe, check=False, timeout=240)
    text = rm.out(r)
    m = re.search(r"^PROBE_RESULT (.+)$", text, re.M)
    result = json.loads(m.group(1)) if m else {"ok": False, "errors": ["pas de PROBE_RESULT"],
                                              "tail": (text + r.stderr.decode())[-800:]}
    result["loaderLogs"] = parse_loader_logs(text)
    return result


def preflight_in_tmp(rm, art, tmp_root):
    """Installe une COPIE (registre + version + current) sous tmp_root et la charge."""
    home = f"{tmp_root}/home"
    rid = release_id(now_stamp(), art["build"]["gitCommit"])
    rel = f"{home}/{INSTALL_REL}/releases/{rid}"
    current = f"{home}/{INSTALL_REL}/current"
    q_root, q_rel, q_home = shlex.quote(tmp_root), shlex.quote(rel), shlex.quote(home)
    try:
        rm.ct(f"rm -rf {q_root} && mkdir -p {q_rel}")
        rm.ct(f"tar -xzf - --strip-components=1 -C {q_rel}", input_bytes=art["bytes"])
        reg = serialize_registry(new_registry([], ADAPTER_TYPE, current, art["version"],
                                              "1970-01-01T00:00:00.000Z"))
        rm.ct(f"ln -s releases/{rid} {shlex.quote(current)} && cat > {q_home}/{REGISTRY_REL}",
              input_bytes=reg.encode())
        links = rm.out(rm.ct(f"find {q_rel} -type l | wc -l; "
                             f"find {q_rel} -type l -lname '/*' | wc -l; "
                             f"find {q_rel} -type f | wc -l")).split()
        result = run_probe(rm, home, expect_dir=rel, catalogue=not art.get("skip_catalogue"))
        # Ce que le chargeur a écrit dans le PAPERCLIP_HOME de la copie (attendu : rien).
        result["homeEntries"] = rm.out(rm.ct(f"cd {q_home} && find . -maxdepth 3 | sort")).split()
        result["copy"] = {"root": tmp_root, "release": rel, "symlinks": int(links[0]),
                          "absoluteSymlinks": int(links[1]), "files": int(links[2])}
        return result
    finally:
        rm.ct(f"rm -rf {q_root}", check=False)
        left = rm.ct(f"test -e {q_root}", check=False).returncode == 0
        log(f"   copie jetable {tmp_root} supprimée : {not left}")


# ─── Écritures (apply / rollback) ───────────────────────────────────────────

def write_registry_atomic(rm, text, expected_sha, stamp):
    """Écrit le registre par temporaire + rename, seulement si l'actuel n'a pas changé."""
    reg = f"{rm.ct_home}/{REGISTRY_REL}"
    tmp = f"{rm.ct_home}/.{REGISTRY_REL}.lot14-{stamp}.tmp"
    script = (f"cat > {tmp} && node -e 'JSON.parse(require(\"fs\").readFileSync(process.argv[1]))' {tmp} "
              f"&& [ \"$(sha256sum {reg} | cut -d' ' -f1)\" = {expected_sha} ] "
              f"&& mv -f {tmp} {reg} || {{ rm -f {tmp}; exit 3; }}")
    rm.ct(script, input_bytes=text.encode())
    now = rm.ct(f"cat {reg}").stdout
    if now != text.encode():
        raise RuntimeError("registre relu différent de celui écrit")
    return sha256_bytes(now)


def switch_current(rm, target_rel, stamp):
    if not re.fullmatch(r"releases/[A-Za-z0-9_.-]+", target_rel or ""):
        raise ValueError(f"version inattendue : {target_rel!r}")
    install = f"{rm.ct_home}/{INSTALL_REL}"
    rm.ct(f"cd {install} && test -f {target_rel}/dist/index.js && "
          f"ln -s {target_rel} current.tmp-{stamp} && mv -T current.tmp-{stamp} current")
    return rm.out(rm.ct(f"readlink {install}/current")).strip()


def restart_and_wait(rm):
    since = rm.utc_now()
    log("== redémarrage du conteneur (docker restart)")
    rm.restart()
    for attempt in range(60):
        time.sleep(3)
        if rm.health() == "200":
            log(f"   API saine après {(attempt + 1) * 3} s")
            return since
    raise RuntimeError("Paperclip ne répond pas 200 sur /api/health après 180 s")


def post_checks(rm, since, expected_dir, release_dir, catalogue=True, strict=True):
    """strict=False : ancienne installation (agency-starter), où les modules sortent du paquet."""
    time.sleep(2)
    info = parse_loader_logs(rm.server_logs(since))
    errs = post_check_errors(info, ADAPTER_TYPE, expected_dir)
    probe = run_probe(rm, rm.ct_home, expect_dir=release_dir if strict else None,
                      catalogue=catalogue, allow_real_home=True,
                      forbid="agency-starter" if strict else None)
    if not probe.get("ok"):
        errs.extend(f"sonde : {e}" for e in probe.get("errors", []))
    return {"serverLogs": info, "probe": probe, "errors": errs}


def apply(rm, args, art, st, report):
    if art["build"].get("dirty") and not args.allow_dirty:
        raise SystemExit("artefact construit avec des modifications non commitées (--allow-dirty)")
    if st["active_runs"] is None or st["active_runs"] > 0:
        raise SystemExit(f"runs actifs : {st['active_runs']} — attendre qu'ils finissent")
    if st["health"] != "200":
        raise SystemExit(f"API non saine avant déploiement (HTTP {st['health']})")

    stamp = now_stamp()
    rid = release_id(stamp, art["build"]["gitCommit"])
    ct_home, host_home, backup_root = rm.ct_home, rm.host_home, rm.backup_root
    install = f"{ct_home}/{INSTALL_REL}"
    current_path = f"{install}/current"
    rel_dir = f"{install}/releases/{rid}"

    log("== 1. sauvegarde sur l'hôte distant (avant toute écriture)")
    members = [REGISTRY_REL]
    old_local = st["localPath"]
    if old_local and not old_local.startswith(ct_home + "/"):
        raise SystemExit(f"localPath hors {ct_home} : {old_local} — sauvegarde impossible")
    if old_local and st["localPathExists"]:
        members.append(old_local[len(ct_home) + 1:])
    if st["current"]:
        members.append(f"{INSTALL_REL}/current")
        members.append(f"{INSTALL_REL}/{st['current']}")
    backup_tar = f"{backup_root}/omniroute-native-pre-deploy-{stamp}.tar.gz"
    backup_reg = f"{backup_root}/adapter-plugins.json.{stamp}"
    quoted = " ".join(shlex.quote(m) for m in dict.fromkeys(members))
    rm.host(f"mkdir -p {backup_root} && tar -czf {backup_tar} -C {host_home} {quoted} "
            f"&& cp -p {host_home}/{REGISTRY_REL} {backup_reg}", timeout=600)
    sums = rm.out(rm.host(f"sha256sum {backup_tar} {backup_reg}")).split()
    count = int(rm.out(rm.host(f"tar -tzf {backup_tar} | wc -l")).strip())
    reg_backup_sha = sums[2]
    if reg_backup_sha != st["registry_sha256"] or count < 2:
        raise SystemExit("sauvegarde incohérente (registre ou archive) — abandon, rien n'a été écrit")
    state = {
        "stamp": stamp, "type": ADAPTER_TYPE,
        "artifact": {"sha256": art["sha256"], "contentSha256": art["contentSha256"],
                     "gitCommit": art["build"]["gitCommit"],
                     "file": pathlib.Path(art["path"]).name},
        "backup": {"tar": backup_tar, "tarSha256": sums[0], "tarMembers": count,
                   "registry": backup_reg, "registrySha256": reg_backup_sha},
        "previous": {"localPath": old_local, "current": st["current"],
                     "registrySha256": st["registry_sha256"]},
        "new": {"localPath": current_path, "release": f"releases/{rid}"},
    }
    state_name = f"omniroute-native-lot14-{stamp}.state.json"
    rm.host(f"cat > {backup_root}/{state_name}",
            input_bytes=json.dumps(state, indent=2).encode())
    log(f"   {backup_tar} sha256={sums[0]} ({count} entrées)")
    log(f"   {backup_reg} sha256={reg_backup_sha}")
    log(f"   état : {backup_root}/{state_name}")
    report["state"] = state

    log(f"== 2. copie de la version {rid}")
    rm.ct(f"mkdir -p {rel_dir}.partial && tar -xzf - --strip-components=1 -C {rel_dir}.partial "
          f"&& mv -T {rel_dir}.partial {rel_dir}", input_bytes=art["bytes"])
    verify = (HERE / "verify-artifact.mjs").read_bytes()
    vtmp = shlex.quote(f"{rm.tmp_prefix}-verify-{stamp}.mjs")
    vr = rm.ct(f"cat > {vtmp} && node {vtmp} --no-lock {rel_dir}; rc=$?; rm -f {vtmp}; exit $rc",
               input_bytes=verify, check=False)
    log("   " + (rm.out(vr).strip().splitlines() or ["?"])[-1][:300])
    if vr.returncode:
        raise SystemExit("la copie installée ne passe pas verify-artifact — registre non modifié")

    # Étapes 3 à 5 : à partir d'ici la production peut avoir changé. TOUTE erreur
    # (bascule, écriture du registre, redémarrage, API non saine, contrôles) mène au
    # même retour arrière automatique (revue A 58201).
    try:
        log("== 3. bascule atomique de current")
        log("   current -> " + switch_current(rm, f"releases/{rid}", stamp))

        log("== 4. registre (temporaire + rename)")
        if old_local == current_path:
            log("   déjà sur …/current : inchangé")
        else:
            text = serialize_registry(new_registry(
                st["records"], ADAPTER_TYPE, current_path, art["version"],
                dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds")
                .replace("+00:00", "Z")))
            log("   sha256=" + write_registry_atomic(rm, text, st["registry_sha256"], stamp))

        since = restart_and_wait(rm)
        log("== 5. contrôles après")
        checks = post_checks(rm, since, current_path, rel_dir, catalogue=not args.skip_catalogue)
        print_checks(checks)
    except Exception as exc:  # noqa: BLE001 — tout échec après la bascule
        log(f"   ÉCHEC après la bascule : {type(exc).__name__}: {str(exc)[:300]}")
        checks = {"errors": [f"exception après la bascule : {type(exc).__name__}: {exc}"]}
    report["postChecks"] = checks
    if checks["errors"]:
        if args.no_auto_rollback:
            raise SystemExit(f"ÉCHEC APRÈS LA BASCULE — retour arrière : --rollback --state {state_name}")
        log("== ÉCHEC APRÈS LA BASCULE → retour arrière automatique")
        rollback(rm, args, state_name, report, force=True)
        raise SystemExit(1)
    log(f"DÉPLOYÉ : {ADAPTER_TYPE} chargé depuis {current_path} -> releases/{rid}")


def print_checks(checks):
    s = checks["serverLogs"]
    log(f"   journaux serveur : chargés={s['loaded_types']} depuis={s['package_dirs']} "
        f"échecs={s['failures']}")
    p = checks["probe"]
    log(f"   sonde : ok={p.get('ok')} type={p.get('effectiveAdapterType')} "
        f"modules={p.get('adapterModuleFiles')} catalogue={p.get('catalogue')}")
    if catalogue_degraded(p.get("catalogue")):
        log("   ATTENTION catalogue de secours (OmniRoute /v1/models lent ou en 503) : "
            "non bloquant, l'adaptateur est chargé")
    for e in checks["errors"]:
        log(f"   ÉCHEC {e}")


def rollback(rm, args, state_name, report, force=False):
    if not state_name:
        names = rm.out(rm.host(f"ls -1 {rm.backup_root}")).split()
        state_name = latest_state(names)
        if not state_name:
            raise SystemExit(f"aucun état omniroute-native-lot14-*.state.json dans {rm.backup_root}")
    if not re.fullmatch(r"omniroute-native-lot14-\d{8}-\d{6}\.state\.json", state_name):
        raise SystemExit(f"nom d'état inattendu : {state_name!r}")
    state = json.loads(rm.host(f"cat {rm.backup_root}/{state_name}").stdout)
    st = read_state(rm)
    if not force and not args.ignore_active_runs and (st["active_runs"] or 0) > 0:
        raise SystemExit(f"runs actifs : {st['active_runs']} (--ignore-active-runs pour forcer)")
    stamp = now_stamp()
    prev = state["previous"]
    ct_home = rm.ct_home
    log(f"== retour arrière vers l'état {state_name}")

    reg = rm.host(f"cat {shlex.quote(state['backup']['registry'])}").stdout
    if sha256_bytes(reg) != state["backup"]["registrySha256"]:
        raise SystemExit("empreinte du registre sauvegardé incorrecte — abandon")
    # Sauvegarde de l'état courant avant de l'écraser (retour arrière du retour arrière).
    rm.host(f"cp -p {rm.host_home}/{REGISTRY_REL} "
            f"{rm.backup_root}/adapter-plugins.json.{stamp}.before-rollback")
    if prev["localPath"] and rm.ct(f"test -e {shlex.quote(prev['localPath'])}",
                                   check=False).returncode != 0:
        log(f"   {prev['localPath']} absent : restauration depuis {state['backup']['tar']}")
        member = prev["localPath"][len(ct_home) + 1:]
        rm.host(f"tar -xzf {shlex.quote(state['backup']['tar'])} -C {rm.host_home} "
                f"{shlex.quote(member)}", timeout=600)
    if prev["current"]:
        log("   current -> " + switch_current(rm, prev["current"], stamp))
    if sha256_bytes(st["registry_raw"]) != sha256_bytes(reg):
        log("   registre restauré sha256=" + write_registry_atomic(
            rm, reg.decode("utf-8"), st["registry_sha256"], stamp))
    since = restart_and_wait(rm)
    expected = prev["localPath"]
    dedicated = expected == f"{ct_home}/{INSTALL_REL}/current" and prev["current"]
    release_dir = f"{ct_home}/{INSTALL_REL}/{prev['current']}" if dedicated else expected
    checks = post_checks(rm, since, expected, release_dir, catalogue=not args.skip_catalogue,
                         strict=bool(dedicated))
    report["rollbackChecks"] = checks
    print_checks(checks)
    if checks["errors"]:
        raise SystemExit("RETOUR ARRIÈRE : contrôles en échec — intervention manuelle")
    log(f"RETOUR ARRIÈRE OK : {ADAPTER_TYPE} chargé depuis {expected}")


def check(rm, args, report):
    """Lecture seule : contrôles « après » sur le serveur tel qu'il tourne (veille, cron)."""
    log("== état de la production (lecture seule)")
    st = read_state(rm)
    print_state(st)
    report["production"] = {k: v for k, v in st.items() if k not in ("registry_raw",)}
    expected = st["localPath"]
    if not expected:
        log(f"   ÉCHEC aucune entrée {ADAPTER_TYPE} dans le registre : agents sur process")
        return 1
    dedicated = expected == f"{rm.ct_home}/{INSTALL_REL}/current" and st["current"]
    release_dir = f"{rm.ct_home}/{INSTALL_REL}/{st['current']}" if dedicated else expected
    checks = post_checks(rm, st["startedAt"], expected, release_dir,
                         catalogue=not args.skip_catalogue, strict=bool(dedicated))
    if not dedicated:
        checks["warnings"] = [f"installation hors chemin dédié ({expected}) : "
                              "un nettoyage du dépôt qui la contient la supprime"]
        log("   ATTENTION " + checks["warnings"][0])
    report["check"] = checks
    print_checks(checks)
    log("CHECK " + ("OK" if not checks["errors"] else "ÉCHEC"))
    return 0 if not checks["errors"] else 1


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    tmp_prefix = check_container_tmp(args.container_tmp)
    if args.sandbox:
        rm = SandboxRemote(args.host, args.container, args.sandbox)
        tmp_prefix = rm.tmp_prefix
        if rm.ct(f"test -f {rm.ct_home}/{REGISTRY_REL}", check=False).returncode:
            raise SystemExit(f"bac à sable : {rm.ct_home}/{REGISTRY_REL} absent (à préparer)")
        log(f"== BAC À SABLE {rm.root} (PAPERCLIP_HOME={rm.ct_home}) : production non touchée")
    else:
        rm = Remote(args.host, args.container, tmp_prefix)
    report = {"mode": args.mode, "sandbox": args.sandbox,
              "at": dt.datetime.now(dt.timezone.utc).isoformat()}
    try:
        if args.mode == "rollback":
            rollback(rm, args, args.state, report)
            return 0
        if args.mode == "check":
            return check(rm, args, report)
        art = ensure_artifact(args.artifact)
        art["skip_catalogue"] = args.skip_catalogue
        report["artifact"] = {k: art[k] for k in ("path", "sha256", "contentSha256", "members",
                                                  "build", "version")}
        log(f"== artefact {art['path']}")
        log(f"   sha256={art['sha256']} membres={art['members']} commit={art['build']['gitCommit'][:7]}"
            f" dirty={art['build']['dirty']}")
        log(f"   contenu (à comparer au CONTENT_SHA256 de la CI) : {art['contentSha256']}")
        log("== état de la production (lecture seule)")
        st = read_state(rm)
        print_state(st)
        report["production"] = {k: v for k, v in st.items() if k not in ("registry_raw",)}
        log("== chargement à blanc par le VRAI chargeur Paperclip (copie sous /tmp du conteneur)")
        pre = preflight_in_tmp(rm, art, f"{tmp_prefix}-{now_stamp()}")
        report["preflight"] = pre
        log(f"   ok={pre.get('ok')} type={pre.get('effectiveAdapterType')} "
            f"modules={pre.get('adapterModuleFiles')} hors-version={pre.get('outsideExpectDir')} "
            f"agency-starter={pre.get('forbiddenHits')} liens={pre.get('copy', {}).get('symlinks')} "
            f"(absolus {pre.get('copy', {}).get('absoluteSymlinks')})")
        log(f"   journaux du chargeur : {pre['loaderLogs']}")
        if pre.get("catalogue"):
            log(f"   catalogue : {pre['catalogue']}"
                + (" — SECOURS (OmniRoute lent), non bloquant"
                   if catalogue_degraded(pre["catalogue"]) else ""))
        for e in pre.get("errors", []):
            log(f"   ÉCHEC {e}")
        if not pre.get("ok"):
            raise SystemExit("chargement à blanc en échec — rien ne sera installé")
        if args.mode == "dry-run":
            rid = release_id("<AAAAMMJJ-HHMMSS>", art["build"]["gitCommit"])
            log("== plan de --apply (non exécuté)")
            log(f"   1. sauvegarde {rm.backup_root}/omniroute-native-pre-deploy-<stamp>.tar.gz "
                f"(+ adapter-plugins.json.<stamp>, état .state.json)")
            log(f"   2. {rm.ct_home}/{INSTALL_REL}/releases/{rid}")
            log(f"   3. current -> releases/{rid}")
            log(f"   4. registre localPath : {st['localPath']} -> {rm.ct_home}/{INSTALL_REL}/current")
            log("   5. docker restart paperclip, puis contrôles (journaux du chargeur, sonde, catalogue)")
            blockers = []
            if st["active_runs"] is None or st["active_runs"] > 0:
                blockers.append(f"runs actifs : {st['active_runs']}")
            if st["health"] != "200":
                blockers.append(f"santé HTTP {st['health']}")
            if art["build"].get("dirty"):
                blockers.append("artefact dirty")
            log("   --apply possible maintenant : " + ("oui" if not blockers else
                                                         "NON (" + "; ".join(blockers) + ")"))
            return 0
        apply(rm, args, art, st, report)
        return 0
    finally:
        if args.report:
            pathlib.Path(args.report).write_text(json.dumps(report, indent=2, default=str,
                                                            ensure_ascii=False))
            log(f"compte rendu : {args.report}")


if __name__ == "__main__":
    sys.exit(main())
