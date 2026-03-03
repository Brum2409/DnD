# ⚔️ DND AI — Dungeon Master Powered by Gemini

An AI-powered DND game website built with pure HTML/CSS/JS — no build tools required.
Hosted on GitHub Pages, data persisted in localStorage.

## Features

- 🤖 AI Dungeon Master with agentic game state control (Stages 5–6)
- 👤 Character creator with AI-generated backstories & portraits (Stage 2)
- 🎒 Persistent inventory with AI-generated item icons (Stage 3)
- 🗺️ Story & campaign manager with scene history (Stage 4)
- 🖼️ AI-generated scene images with Ken Burns animation (Stage 7)
- 📚 Item library with bulk icon generation (Stage 8)

## Setup

1. Fork this repo
2. Enable GitHub Pages (Settings → Pages → Deploy from main branch)
3. Open the site and enter your free Gemini API key in ⚙️ Settings
4. Create characters, start a campaign, and begin your adventure!

## Free APIs Used

- **Google Gemini Flash** — AI text generation (get a free key at [ai.google.dev](https://ai.google.dev))
- **Pollinations.ai** — Free image generation, no API key needed!

## Tech Stack

- Vanilla JS ES Modules
- CSS Custom Properties
- LocalStorage (all persistence, no backend)
- No build tools — works directly on GitHub Pages

## Project Structure

```
dnd-ai/
├── index.html              ← Dashboard / home
├── character-create.html   ← Character creation wizard
├── character-manager.html  ← Character sheet & inventory
├── story-manager.html      ← Campaign & scene management
├── game.html               ← Main game screen (DM chat)
├── css/
│   ├── base.css            ← CSS variables, reset, typography
│   ├── components.css      ← Reusable UI components
│   └── layout.css          ← Page layouts
├── js/
│   ├── db.js               ← localStorage CRUD (single source of truth)
│   ├── api-gemini.js       ← Gemini API wrapper
│   ├── api-image.js        ← Pollinations.ai image generation
│   ├── router.js           ← Hash-based router
│   └── utils.js            ← Shared helpers (uuid, dice, modifiers)
└── assets/
    └── icons/              ← Cached AI-generated item icons
```

## Build Stages

| Stage | Content | Status |
|-------|---------|--------|
| 1 | Foundation: db.js, utils.js, CSS, index.html | ✅ Complete |
| 2 | Character Creator wizard | 🔜 Upcoming |
| 3 | Character Manager & Inventory | 🔜 Upcoming |
| 4 | Story & Campaign Manager | 🔜 Upcoming |
| 5 | AI Dungeon Master core | 🔜 Upcoming |
| 6 | DM Agentic Tool System | 🔜 Upcoming |
| 7 | Scene images & Visual polish | 🔜 Upcoming |
| 8 | Item Library | 🔜 Upcoming |
| 9 | Final integration & deploy | 🔜 Upcoming |
