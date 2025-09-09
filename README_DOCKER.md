# Bulk Foto – Docker Deploy

## Vereisten
- Docker 24+ en Docker Compose V2
- Poort 3000 vrij op de host (of wijzig `PORT` in `.env`)

## Snel starten
1. Kopieer `.env.example` naar `.env` en pas eventueel aan.
2. (Optioneel) Maak lokale mappen:
   ```bash
   mkdir -p uploads storage
   ```
3. Build & run:
   ```bash
   docker compose up --build -d
   ```
4. Open: http://localhost:3000

## RAW-ondersteuning
Deze container bevat:
- `darktable-cli`
- `rawtherapee-cli`
- `dcraw_emu` (via `libraw-bin`)
De app kan zo `.ARW`, `.CR2`, `.CR3`, `.NEF`, `.RAF`, `.RW2`, `.DNG` etc. naar TIFF/JPG converteren.

## Volumes
- `./uploads` ↔ `/app/uploads`
- `./storage` ↔ `/app/storage`

## Healthcheck
Als je app een health-endpoint heeft op `/health`, blijft de container gezond.
Heb je dat niet? Verwijder of pas de healthcheck aan.

## Logs
```bash
docker compose logs -f
```

## Updaten
```bash
docker compose pull
docker compose up -d --build
```

## Tips voor performance
- Run op een machine met AVX2 voor snellere `sharp`-bewerkingen
- Bind mounts (`uploads/`, `storage/`) op SSD/NVMe
- Zet `MAX_WORKERS` in `.env` gelijk aan het aantal CPU-cores
