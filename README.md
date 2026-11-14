# Adaptateurs Pupitre

Catalogue public des adaptateurs de Pupitre, une app macOS qui affiche
les sessions de CLI d'agents (Claude Code…) en séparant l'agent principal de ses sous-agents.

Un adaptateur traduit le format de transcript d'un CLI en événements normalisés. Il est chargé à l'exécution
par l'app, ce qui permet de suivre un changement de format sans republier l'app.

```
<id>.pupitre-adapter/
├── manifest.json   # id, version, adapterApi, versions du CLI testées, gabarits de lancement, chemins
├── decoder.js      # fonctions pures : decodeLine, decodeFile, decodeAgentMeta, discover, mapHookEvent
├── fixtures/       # transcripts réels anonymisés + expected.json
└── test/run.js     # tests Node sans dépendance
```

- `decoder.js` est du JavaScript pur, sans aucune entrée/sortie : il tourne à l'identique dans Node et dans JavaScriptCore
  (où l'app l'exécute sans accès au disque, au réseau ni aux processus).
- L'app refuse toute option de lancement qui touche aux permissions (`--dangerously-skip-permissions`,
  `--permission-mode`, `--allowedTools`…), quel que soit l'adaptateur.
- Hooks : l'adaptateur ne fait que demander des noms d'événements (`manifest.hooks`) ; l'app les filtre, génère elle-même
  le fichier de réglages (clé `hooks` seule) et n'y met jamais d'autre commande que son propre relais `pupitre-hook`.
- `index.json` liste les adaptateurs publiés. Les paquets seront signés (ed25519) avant la première distribution.

## Tests

```bash
node claude-code.pupitre-adapter/test/run.js            # fixtures + tests unitaires
node claude-code.pupitre-adapter/test/run.js --update   # régénère les expected.json
```

## Adaptateurs

| Adaptateur | CLI | Versions testées |
|---|---|---|
| `claude-code` | Claude Code | 2.1.295 – 2.1.x |
