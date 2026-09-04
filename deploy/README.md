# Шпаргалка по эксплуатации (VPS)

Только команды, без теории. Всё выполняется на сервере, в `~/sillytavern-mp`.

## Обновить проект

```bash
cd ~/sillytavern-mp
git pull origin master
```

Если git ругается на конфликт `package-lock.json` (или любой другой файл, которого раньше не было в репо) — он просто мешается, безопасно удалить и повторить:
```bash
rm keeper/package-lock.json
git pull origin master
```

После обновления, если менялись `keeper/` или `server/` — обнови зависимости и перезапусти:
```bash
cd ~/sillytavern-mp/keeper && npm install --omit=dev --no-audit --no-fund
cd ~/sillytavern-mp/server && npm install --omit=dev --no-audit --no-fund
sudo systemctl restart sillytavern-mp tavern-keeper
```

## Перезапустить / посмотреть статус

```bash
sudo systemctl restart sillytavern-mp   # relay-сервер
sudo systemctl restart tavern-keeper    # headless-браузер

sudo systemctl status sillytavern-mp
sudo systemctl status tavern-keeper
```

## Логи

```bash
journalctl -u sillytavern-mp -f    # сервер
journalctl -u tavern-keeper -f     # кипер (headless-браузер)
```
`Ctrl+C` чтобы выйти.

## Кипер: что это и как понять, что он живой

Кипер держит headless-вкладку таверны открытой 24/7 и следит за папкой SillyTavern — если ты добавил пресет/персонажа/мир через свой SSH-туннель, кипер сам перезагрузит вкладку через пару секунд.

Проверить, что слежка включена:
```bash
journalctl -u tavern-keeper -n 30 --no-pager | grep watching
```
Должна быть строка `[keeper] watching for ST data changes: ...` со списком папок. Если её нет — см. ниже.

Путь к данным таверны задаётся через `ST_DATA_PATH`, лежит тут:
```bash
cat /etc/systemd/system/tavern-keeper.service.d/override.conf
```

Поменять путь:
```bash
sudo tee /etc/systemd/system/tavern-keeper.service.d/override.conf <<'EOF'
[Service]
Environment=ST_DATA_PATH=/путь/до/SillyTavern/data/default-user
EOF
sudo systemctl daemon-reload
sudo systemctl restart tavern-keeper
```

Найти путь к таверне, если забыл:
```bash
find / -maxdepth 6 -type d -iname "SillyTavern" 2>/dev/null | grep -v sillytavern-mp
ls <результат>/data     # там папка юзера, обычно default-user
```

## Частые ошибки

| Сообщение в логе | Причина | Лечение |
|---|---|---|
| `error: ... untracked working tree files would be overwritten` при `git pull` | Файл, который раньше не был в репо, теперь появился в новом коммите | `rm` этот файл и `git pull` заново |
| `Error: Cannot find module 'xxx'` | После `git pull` не обновили зависимости | `npm install --omit=dev` в `keeper/` и/или `server/`, потом restart |
| Нет строки `watching for ST data changes` в логе кипера | `ST_DATA_PATH` не задан или указывает не туда | см. раздел "Кипер" выше |
| `ST_DATA_PATH is set but none of the expected subfolders exist there` | Путь указывает не на папку юзера, а мимо (например, на корень таверны) | путь должен заканчиваться на `.../data/default-user`, а не на `.../SillyTavern` |
| Пресет/персонаж не подхватывается вообще | Кипер не перезапускался после последнего `git pull`, где появился watcher | `sudo systemctl restart tavern-keeper`, затем проверить `watching for ST data changes` в логе |
