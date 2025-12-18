# BackEndExpress – API Routes Documentation

This document describes the HTTP routes exposed by the server: how to call them, what query parameters are supported, and what you get back.

## Base URL

By default the server runs on port `3000`:

- Local: `http://localhost:3000`

Port is configured by `PORT`.

## Routes

All summary routes are mounted under `/summaries`.

### GET /summaries

List stored article summaries (paginated).

**Query parameters**

- `page` (optional, default: `1`) – 1-based page number
- `limit` (optional, default: `20`, max: `100`) – items per page

**Example**

```bash
curl "http://localhost:3000/summaries?page=1&limit=20"
```

**200 Response**

```json
{
   "items": [
      {
         "_id": "6762c5a2c4b6b62f8e2d1e11",
         "title": "...",
         "author": "...",
         "url": "https://example.com/article",
         "feed": { "feedUrl": "https://example.com/rss", "title": "Example Feed" },
         "source": { "domain": "example.com" },
         "publishedAt": "2025-12-18T00:00:00.000Z",
         "ingestedAt": "2025-12-18T12:34:56.000Z",
         "content": {
            "imageUrl": "https://example.com/image.jpg"
         },
         "summary": {
            "version": 1,
            "points": [
               { "heading": "...", "bullets": ["...", "..."], "paragraph": "..." }
            ]
         }
      }
   ],
   "pageInfo": {
      "page": 1,
      "limit": 20,
      "total": 123,
      "hasNext": true
   }
}
```

**Notes**

- `content.imageUrl` is an optional string. It may be missing/empty if the extractor couldn’t find a good image.
- The list endpoint intentionally does **not** include `content.rawText`.

### GET /summaries/:id

Fetch a single stored summary by Mongo ObjectId.

**Path parameters**

- `id` (required): Mongo ObjectId of the summary

**Query parameters**

- `includeRaw` (optional, default: `false`) – if true, include `content.rawText`

**Examples**

```bash
curl "http://localhost:3000/summaries/6762c5a2c4b6b62f8e2d1e11"
```

```bash
curl "http://localhost:3000/summaries/6762c5a2c4b6b62f8e2d1e11?includeRaw=true"
```

**200 Response**

Returns the stored document. If `includeRaw=false`, `content.rawText` is omitted.

**Error responses**

- `400` – invalid id (`{ "message": "Invalid id" }`)
- `404` – not found (`{ "message": "Not found" }`)

## Field reference (common)

Common fields you’ll see in responses:

- `title`, `author`, `url`
- `feed.feedUrl`, `feed.title`
- `source.domain`
- `publishedAt`, `ingestedAt`, `lastSeenAt`
- `content.excerpt`, `content.wordCount`, `content.imageUrl`
- `summary.points` – array of 10 items, each with:
   - `heading`
   - either `bullets` (2–5 strings) and/or `paragraph`

## Where routes are defined

- Router: [src/routes/summaries.route.js](src/routes/summaries.route.js)
- Controller: [src/controllers/summaries.controller.js](src/controllers/summaries.controller.js)

## Quick troubleshooting (API)

- If `/summaries` returns an empty list, it usually means the background fetch/summarize job hasn’t ingested anything yet.
- If the server starts but summaries aren’t appearing, check the server logs for RSS fetch failures or Gemini overload errors.
