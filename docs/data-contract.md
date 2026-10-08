# Track and Stem Data Contract

Status: Draft — pending review by both team members.

This document describes the proposed Track/Stem format exchanged
between the StemForge backend and frontend.

The sample object is stored in `docs/data-contract.json`.
It contains illustrative metadata and placeholder audio URLs.

## Field definitions

| Field | JSON type | Meaning |
|---|---|---|
| `_id` | string | Track ID represented as a MongoDB ObjectId string |
| `title` | string | Track title |
| `artistId` | string | Owner's user ID; not a populated user object |
| `genre` | string | Music genre |
| `bpm` | number | Tempo in beats per minute |
| `key` | string | Musical key, for example `Am` |
| `tags` | array of strings | Search and discovery tags |
| `coverImageUrl` | string or null | Cover image URL; null when absent |
| `description` | string | Track description; empty string when absent |
| `isPublic` | boolean | Whether other users can access the track |
| `isDownloadable` | boolean | Whether the application offers downloads to listeners |
| `stems` | array of objects | Audio stems belonging to this track |
| `likesCount` | number | Non-negative integer maintained by the backend |
| `createdAt` | string | ISO 8601 timestamp in UTC |

Each stem contains:

| Field | JSON type | Meaning |
|---|---|---|
| `stemId` | string | Stable stem ID represented as a MongoDB ObjectId string |
| `name` | string | Display label, for example `Drums` or `Bass` |
| `audioUrl` | string | HTTPS URL used for audio playback |
| `duration` | number | Positive duration in seconds; decimals are allowed |
| `fileSize` | number | Positive integer representing file size in bytes |

## Ownership and account roles

The proposed database roles are `user` and `admin`, following the
schema in the project plan.

A normal user can both upload their own tracks and listen to tracks.
Creator and Listener describe activities, not separate account types.

- The backend sets `artistId` from the authenticated user.
- Clients cannot choose another owner when creating a track.
- Users can edit or delete only their own tracks.
- Public tracks can be browsed and played without signing in.
- Creating tracks and liking public tracks require authentication.
- Private tracks are accessible only to their owner.
- Administrative features are outside this initial contract.

## Mixer conventions

- Use `stemId` as the stable identifier for each mixer channel.
- Use `name` as the channel label.
- Preserve the order of the `stems` array.
- All stems start at timeline position zero.
- Audio files must already be aligned before upload.
- The backend stores metadata; it does not align audio files.
- Use the longest stem duration as the overall timeline duration.
- A shorter stem becomes silent after reaching its end.
- The initial project limit is four stems per track.
- Audio formats are MP3 and WAV, as specified in the project plan.

The sample URLs under `example.invalid` cannot play audio.
Replace them with real demo audio URLs before testing playback.

`isDownloadable` controls the application's download action.
Playback still requires an audio URL; this flag does not make
publicly accessible audio impossible to save.

## Proposed API response format

The sample JSON describes the Track object itself.

The planned detail endpoint is `GET /api/tracks/:trackId`.
Its successful response wraps the Track object in `data`:

```json
{
  "data": {
    "_id": "507f1f77bcf86cd799439011",
    "...": "The remaining fields follow data-contract.json"
  }
}
```

The example above abbreviates the object; `...` is not an API field.

The planned list endpoint is `GET /api/tracks`:

```json
{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 12,
    "total": 0,
    "totalPages": 0
  }
}
```

Error responses contain a readable message, for example:

```json
{
  "message": "Track not found"
}
```

These Track endpoints are planned and are not implemented yet.
The existing `/api/health` response keeps its current format.

## Review checklist

- [ ] Both members agree on field names, types, units, and null values.
- [ ] Phuc confirms the format fits the mixer and frontend state.
- [ ] Both members agree on ownership and account-role behavior.
- [ ] Both members agree on API wrappers and mixer timeline behavior.
- [ ] The same JSON sample is included in the client repository.

Changes to this contract must be documented and communicated
before changing the backend or frontend implementation.