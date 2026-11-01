# .githooks — enforcement de versionado (Atenea)

Hooks git-native (POSIX, sin dependencias). Corren para **cualquier** commit, hecho por una
persona o por un agente. Alinean el manual de versionado del equipo.

- **`commit-msg`** — bloquea el commit si el mensaje no sigue Conventional Commits
  (`<tipo>(<alcance>)(!): descripción`). Avisa (no bloquea) si el tipo no cuadra con el prefijo
  de la rama.
- **`pre-commit`** — bloquea commits directos sobre `main` o `beta` (el desarrollo va en ramas
  temporales). Escape para promoción de release: `ATENEA_ALLOW_PROTECTED=1 git commit ...`.

## Activación

`core.hooksPath` es config local por clon (no se versiona), así que cada clon la activa una vez.
El proyecto lo automatiza con un script `prepare` en `package.json`:

```json
"scripts": { "prepare": "git config core.hooksPath .githooks || true" }
```

Así, en cada `yarn install` queda cableado. Manual, si hiciera falta:

```bash
git config core.hooksPath .githooks
chmod +x .githooks/*
```

Bypass puntual de un hook (no recomendado): `git commit --no-verify`.
