# Correspondência de identificadores de commit

Em 13/10/2026 o histórico local foi reescrito para corrigir a autoria de
oito commits: a configuração do Git copiada junto com o projeto estava com a
identidade de outro integrante do grupo, e os commits abaixo, escritos por
José Carlos Paim Pamplona, tinham sido gravados em nome dele. Só o autor
mudou: o conteúdo de cada commit (a árvore de arquivos) e as datas originais
são idênticos aos de antes.

Arquivos e mensagens gravados antes da correção citam os identificadores
antigos -- por exemplo, os `ambiente.json` de `resultados/` registram o
commit `210fd82`, que hoje é `7990661`. Use esta tabela para converter.

| Antigo | Atual | Commit |
|---|---|---|
| `966ec5e` | `ae8255f` | Criptografia em duas camadas dos dados sensíveis |
| `ae1fc29` | `f9c28e1` | Script de demonstrações de ataque |
| `5cf97b8` | `238006d` | Encurta as prévias de texto da demonstração |
| `210fd82` | `7990661` | Hipóteses do experimento e benchmark dos três cenários |
| `d917a88` | `6b07aa9` | Resultados oficiais do benchmark |
| `ae0bfa4` | `96aabfb` | Rascunho da seção de LGPD da monografia |
| `667f071` | `0ccdcff` | Correções de LGPD |
| `44ba962` | `2679d7f` | Gráficos do benchmark |

Para conferir que o conteúdo não mudou, compare as árvores (o histórico
antigo está na branch local `backup-autoria-anterior`):

    git rev-parse 210fd82^{tree} 7990661^{tree}
