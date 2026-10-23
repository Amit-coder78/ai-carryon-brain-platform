// Written in the same transaction as the change it records. Never put secrets or raw comments in detail.
export async function audit(client, ctx, action, objectType, objectId, detail = {}) {
  await client.query(
    `INSERT INTO audit_log (workspace_id, actor, action, object_type, object_id, correlation_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [ctx.workspaceId, ctx.actor, action, objectType, objectId, ctx.correlationId, JSON.stringify(detail)]
  );
}
