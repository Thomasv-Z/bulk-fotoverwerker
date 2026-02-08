# 📸 Bulk Photo Processor

A simple and scalable web application for processing photos in bulk.
Built with **Node.js** and **Docker**, this tool allows you to upload and process large batches of images efficiently using background workers.

---

## 🚀 Features

* Upload multiple photos at once
* Add watermarks with ease
* 

## 🛠️ Installation (Local Development)

### 1. Clone the repository

```bash
git clone https://github.com/Thomasv-Z/bulk-fotoverwerker.git
cd bulk-fotoverwerker
```

### 2. Install dependencies

```bash
npm install
```

### 3. Start the application

```bash
npm start
```

Then open your browser and navigate to:

```
http://localhost:3000
```

(Port may vary depending on configuration.)

---

## 🐳 Running with Docker (Recommended)

This repository includes a `Dockerfile` and `docker-compose.yml` for containerized deployment.

```bash
docker compose up --build
```

Benefits:

* No local Node.js installation required
* Reproducible environment
* Easy deployment

---

## 📦 Requirements

* Node.js (LTS recommended)
* npm or Yarn
* Optional: Docker & Docker Compose
