# HTTP API

Base `/fighting/api/v1/`. JSON, errors `{error:string}`. Admin writes require same-origin and `X-CSRF-Token`; cookie session required for ALL admin routes except login. Timestamps UTC milliseconds. Query start/end accept numeric UTC milliseconds or RFC3339. Intervals [start,end), default recent 3h. Secret/token/password never logged.

- `POST ingest/batches` Bearer: `{schemaVersion:2,batchId,sourceId,sessionId,context:{sessionStartedAtMs,realm,line,clockOffsetMs,clockUncertaintyMs},messages:[MergedMessage]}`. Ack `{batchId,accepted:[{id,sessionId,revision}],rejected:[{id,sessionId,revision,code,retryable}]}`. sourceId bound to token. Same revision immutable hash excludes lastObservedAtMs/observations/lastFrameId.
- `GET time` Bearer/admin: `{serverTimeMs}`.
- `POST admin/login` `{username:"admin",password}` → `{username:"admin",csrfToken}` with cookie. `GET admin/session` same. `POST admin/logout` → `{ok:true}`.
- `GET admin/events?start=&end=&limit=200&offset=0` → `{events:[{id,occurredAtMs,text,killer,victim,killerFaction,victimFaction,status,reason,sourceCount,sourceIds,configVersion}],total,projectionVersion}`. status counted/excluded/pending/duplicate.
- `GET admin/messages/:id` → `{event,sources:[{sourceId,sessionId,messageId,revision,text,firstObservedAtMs,lastObservedAtMs,gameTime,eventAtMs,receivedAtMs,context}],overrides:[]}`.
- `GET admin/stats?start=&end=` → `{startMs,endMs,projectionVersion,overview:{aKills,bKills,aPlayers,bPlayers,aShare,bShare,ratio},kills:[{name,faction,count,opponents:[{name,count}]}],deaths:[same],kda:[{name,faction,kills,deaths,ratio:number|null}],advantages:{a:{startMs,endMs,aKills,bKills,net},b:{...}}}`. Shares 0..1. All statistics counted A/B opposition only.
- `GET admin/name-configs` → `{active:{id,nameA:[],nameB:[],nameOthers:[],aliases:[{canonical,alias}],blacklist:[],createdAtMs},versions:[{id,createdAtMs}]}`. `POST admin/name-configs` same arrays → `{id,jobId}`.
- `GET admin/collector-credentials` → `{sources:[{sourceId,label,revoked}]}`. `POST admin/collector-credentials` `{sourceId?:string,label?:string,revoke?:boolean}` → `{sourceId,token}` on creation (secret once), `{sourceId,revoked:true}` on revocation.
- `POST admin/event-overrides` `{requestId,eventId,killer?,victim?,status?:"counted"|"excluded",excluded?:boolean,reason,split?:boolean,mergeInto?:string,reset?:boolean}` → `{ok:true,jobId}`. `reset:true` removes this event's effective overrides with an audit entry and full rebuild; cyclic merge targets are rejected.
- `POST admin/reprocess` `{}` → `{jobId}`. `GET admin/jobs` → `{jobs:[{id,status,error?,createdAtMs,finishedAtMs?}]}`.
- `POST admin/exports` `{start?,end?,projectionVersion?}` → XLSX binary attachment. If requested projection no longer current return 409; UI refetches before export.
- `GET admin/stream` SSE `event: update`, id generation, data `{projectionVersion}`. Snapshot on connect/reconnect, then updates. Heartbeat, client refetches bounded snapshots.

CLI: `server --data-dir <path> --init-admin` reads `QQSG_ADMIN_PASSWORD`, initializes/reset admin and revokes sessions. Serve `server --data-dir <path> --listen 127.0.0.1:8780 --origin https://jinbaofu.cn`. Explicit local development `--insecure-local` with loopback HTTP. Go tests `go test ./...`.

`--import-names <directory>` imports name_a/name_b/name_others plus optional aliases.tsv/blacklist.txt, snapshots a new version and exits; worker processes it on service startup. `--backup <new absolute filename>` creates a consistent SQLite backup including configuration versions. Schema 1 is embedded; unknown future schema versions refuse startup.

Wire UTC timestamps are integer milliseconds (the capture client rounds only during serialization). Permanent rejections always include `retryable:false`. Ack may include `jobId` for log correlation. Events carry `algorithmVersion`, `timeQuality`, `timeReason`, and nullable `eventTimeUncertaintyMs`; observed-only time is not a precise event clock. Same reliable game second/context/known pair may associate multiple message IDs, including one source; raw revisions remain intact.

Query ranges are at most 31 days; event lists use SQL pagination. Statistics/Excel reject more than 20,000 events or 32 MiB event JSON and use a 3s query deadline. UI/export bind a published projectionVersion. Local verification preceded the user's subsequent production deployment authorization; deployment receipts identify the actual release.
