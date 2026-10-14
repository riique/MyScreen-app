# Servidor: o que muda para o app de Windows

O app usa o **mesmo** servidor Ubuntu (Caddy + LiveKit + Next.js) e **nenhuma porta nova**.
A sinalização vai por `wss://DOMINIO/rtc`, a mídia vai direto ao SFU (UDP) ou pelo TURN, e a API
é a mesma do site. Só três coisas entram no servidor, e nenhuma delas é obrigatória para o app
funcionar — sem elas, só a atualização automática e os links do site ficam de fora.

## 1. Diretório de releases (uma vez, por SSH)

```bash
sudo mkdir -p /opt/myscreen/releases
sudo chown "$USER":"$USER" /opt/myscreen/releases
```

## 2. Rota `/downloads/` no Caddy

O feed do `electron-updater` (`latest.yml`) precisa estar sempre fresco; atrás do Cloudflare
(produção atual) o `Cache-Control: no-cache` é obrigatório, senão o app não enxerga a versão nova.

**Produção atual** (`docker-compose.prod.yml`: Caddy do sistema + Cloudflare Tunnel) — no
Caddyfile **do host**, dentro do bloco do domínio e antes do `reverse_proxy` do app:

```caddy
	# Instalador do app de Windows e feed do electron-updater.
	handle_path /downloads/* {
		root * /opt/myscreen/releases
		@feed path *.yml
		header @feed Cache-Control "no-cache"
		file_server
	}
```

Depois: `sudo systemctl reload caddy`.

**VPS dedicado** (`docker-compose.yml` + `Caddyfile` do repositório) — o mesmo bloco, com
`root * /srv/releases`, antes do `handle` final; e no serviço `caddy` do compose:

```yaml
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./releases:/srv/releases:ro
```

(acrescente `releases/` ao `.gitignore` e ao `.dockerignore`, e `mkdir -p releases` no `deploy.sh`).

**Aceite:** `curl -I https://DOMINIO/downloads/latest.yml` responde 200 com `Cache-Control: no-cache`
depois da primeira publicação.

## 3. Publicar uma versão

Na máquina Windows de build, com `~/.ssh/config` apontando o host `myscreen`:

```powershell
npm run publish:desktop
```

O script gera o instalador, envia `.exe` + `.blockmap`, copia para `MyScreen-Setup-latest.exe`
(link estável para o site) e troca o `latest.yml` por último, com `mv` atômico.

## 4. Mudanças opcionais no site (repositório `MyScreen/`)

| Onde | Mudança |
| :--- | :--- |
| `src/app/page.tsx` | Link "Baixar o app para Windows" → `/downloads/MyScreen-Setup-latest.exe`. |
| `src/app/room/[id]/page.tsx` | Botão discreto "Abrir no app" → `myscreen://room/<id>`. |
| `src/app/api/desktop/route.ts` | Copie `site/api-desktop-route.ts` daqui. Só é preciso quando houver mudança incompatível: com `DESKTOP_MIN_VERSION=1.2.0` no `.env`, apps mais velhos bloqueiam "Entrar" e pedem atualização. Sem a rota (404), o app não exige nada. |

**Compatibilidade de chat:** o app trava `@livekit/components-react@2.9.24` e
`livekit-client@2.22.3`, as versões do `package-lock.json` do site. Ao atualizar uma, atualize a
outra junto — versões diferentes do protocolo de chat não conversam.
