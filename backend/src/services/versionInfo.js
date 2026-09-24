export async function readSchemaVersion(queryFn) {
  try {
    const result = await queryFn(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1'
    );
    return result.rows[0]?.version || 'none';
  } catch {
    return 'unavailable';
  }
}
