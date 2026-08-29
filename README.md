# vscode-glua-enhanced + self-hosted gmodwiki

Форк [WilliamVenner/vscode-glua-enhanced](https://github.com/WilliamVenner/vscode-glua-enhanced) —
плагина VS Code для GLua (Garry's Mod Lua) — с интеграцией нашей self-hosted вики
(репозиторий **gmodwiki-selfhosted**): всё, что задокументировано на вики
(например, аддон **Trolleybus System**), получает автодополнение, hover-подсказки
и подсказки сигнатур наравне с официальным API, и обновляется автоматически при
изменении страниц вики.

## Что добавлено к оригиналу

- **`src/customWikiProvider.js`** — загрузка `/gluadump.json` с вики, слияние с
  официальными данными, кеш в globalState (работает офлайн), опрос обновлений
  (лёгкий `?check=1`, версия меняется при любом изменении страниц или формата дампа);
- хуки из custom-вики в **`hook.Add("` / `hook.Call("`** (семейства с флагом
  `HOOK_ADD` из дампа; `ENT:`/`WEAPON:`-оверрайды по-прежнему не предлагаются);
- автодополнение имён событий в **`Trolleybus_System.RunEvent("`** (без приставки
  `TrolleybusSystem_`) и **`Trolleybus_System.RunChangeEvent("`** (ещё и без
  суффикса `Changed`) — функции-диспетчеры и приставки объявляет сам дамп;
- ссылки **Wiki**/**Edit** в hover ведут на страницы и редактор вашей вики;
- настройки:

| Настройка | По умолчанию | Описание |
|---|---|---|
| `glua-enhanced.customWiki.url` | `http://127.0.0.1:4321` | Базовый URL вики (пустая строка — выключить) |
| `glua-enhanced.customWiki.pollSeconds` | `60` | Период проверки обновлений, сек (0 — только при старте) |

## Сборка и установка

Требуется Node.js 18+ и git (зависимость `gluaparse` ставится из git).

```sh
npm ci
npx webpack --mode production
npx vsce package
```

Получится `vscode-glua-enhanced-<версия>.vsix`. Установка:

```sh
code --install-extension vscode-glua-enhanced-2.6.3.vsix
```

или в VS Code: Extensions → `...` → **Install from VSIX...**. Версию из
маркетплейса перед этим удалите. Подробности — в [BUILD.md](BUILD.md).

## Развёртывание связки целиком

1. Разверните вики по README репозитория **gmodwiki-selfhosted** (Node/Docker,
   PostgreSQL, импорт документации из `db_backup/`).
2. Установите этот плагин и укажите адрес вики в `glua-enhanced.customWiki.url`.
3. Проверка: откройте `.lua`-файл (режим языка — **GLua**), наберите
   `Trolleybus_System.` — должно появиться автодополнение библиотеки; в
   Developer Tools → Console будет строка `vscode-glua: custom wiki ingested (…)`.

Если автодополнения нет:
- статус-бар должен показывать язык **GLua** (а не Lua другого расширения);
- вики должна быть доступна по настроенному URL (или будет использован кеш);
- лог активации: Help → Toggle Developer Tools → Console.

## Важно для разработчиков форка

`babel.config.json` транспилирует под **node 7** — в `src/` нельзя использовать
`async/await` (вкомпилируется вызов отсутствующего `regeneratorRuntime`, и
активация упадёт). Только промисы/колбэки, как в остальном коде.

---

Оригинальный плагин: © William Venner, GPL-3.0 ([исходный README](https://github.com/WilliamVenner/vscode-glua-enhanced)).
