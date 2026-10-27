import pg from 'pg';
import type { DatabaseConfig } from '@rook/config';
import type { Logger } from '@rook/observability';
import { type SqlFragment } from './sql.js';

const { Pool, types } = pg;

/**
 * The PostgreSQL connection pool and the query interface everything else uses.
 *
 * Two driver-level decisions are made here, once, because getting them wrong
 * is subtle and the symptoms appear far away:
 *
 *   * `bigint` (int8) is parsed to a JavaScript number rather than left as a
 *     string. Our int8 columns are byte sizes and counts, which stay far below
 *     2^53, and having `byteSize` arrive as `"1024"` would silently break
 *     arithmetic. Any future int8 that can exceed 2^53 must opt out of this.
 *
 *   * `statement_timeout` is set per connection. Without it one pathological
 *     query holds a pool slot indefinitely and the service stops serving
 *     anything, which looks like a total outage rather than a slow query.
 */

// int8 -> number. See the note above before adding a column that could exceed
// Number.MAX_SAFE_INTEGER.
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

// numeric -> number. Rook has no monetary or high-precision columns; if one is
// ever added, it must be read as a string instead.
types.setTypeParser(types.builtins.NUMERIC, (value) => Number.parseFloat(value));

export interface QueryResult<Row> {
  readonly rows: Row[];
  readonly rowCount: number;
}

/**
 * The minimal surface repositories are written against.
 *
 * Both the pool and a single transaction-bound client satisfy this, which is
 * what lets one repository method run either standalone or inside a caller's
 * transaction without knowing which.
 */
export interface Queryable {
  query: <Row>(fragment: SqlFragment, operation: string) => Promise<QueryResult<Row>>;
}

export interface DatabaseClient extends Queryable {
  /**
   * Runs `work` inside a transaction, committing on success and rolling back
   * on any thrown error.
   */
  transaction: <T>(operation: string, work: (tx: Queryable) => Promise<T>) => Promise<T>;
  /** For the migrator and health checks, which need the raw driver. */
  readonly pool: pg.Pool;
  /** Pool saturation, exposed for health reporting. */
  stats: () => { total: number; idle: number; waiting: number };
  close: () => Promise<void>;
}

export interface CreateDatabaseOptions {
  readonly config: DatabaseConfig;
  readonly logger: Logger;
  /** Optional histogram, observed per query, labelled by operation name. */
  readonly onQueryDuration?: (operation: string, seconds: number) => void;
}

/** Queries slower than this are logged for investigation. */
const SLOW_QUERY_MS = 200;

export function createDatabaseClient(options: CreateDatabaseOptions): DatabaseClient {
  const { config, logger, onQueryDuration } = options;

  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    idleTimeoutMillis: config.idleTimeoutMs,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    ssl: config.ssl ? { rejectUnauthorized: true } : undefined,
    // Applied to every connection in the pool as it is created.
    options: `-c statement_timeout=${config.statementTimeoutMs}`,
    application_name: 'rook',
  });

  // An idle client can fail (network blip, server restart). `pg` emits that
  // here, and an unhandled 'error' event on the pool would crash the process.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle database client errored; it will be replaced');
  });

  async function runQuery<Row>(
    executor: pg.Pool | pg.PoolClient,
    fragment: SqlFragment,
    operation: string,
  ): Promise<QueryResult<Row>> {
    const { text, values } = fragment.toQuery();
    const started = performance.now();

    try {
      const result = await executor.query<Row extends pg.QueryResultRow ? Row : never>(
        text,
        values,
      );
      const durationMs = performance.now() - started;
      onQueryDuration?.(operation, durationMs / 1000);

      if (durationMs > SLOW_QUERY_MS) {
        // The SQL text is safe to log; the parameter values are not, since
        // they can contain message content and email addresses.
        logger.warn(
          { operation, durationMs: Math.round(durationMs), rowCount: result.rowCount ?? 0 },
          'slow query',
        );
      }

      return {
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
      };
    } catch (error) {
      onQueryDuration?.(operation, (performance.now() - started) / 1000);
      // Log the operation name and the SQL, never the values.
      logger.error({ operation, sql: text, err: error }, 'query failed');
      throw error;
    }
  }

  return {
    pool,

    query<Row>(fragment: SqlFragment, operation: string): Promise<QueryResult<Row>> {
      return runQuery<Row>(pool, fragment, operation);
    },

    async transaction<T>(operation: string, work: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const started = performance.now();

      try {
        await client.query('begin');

        const tx: Queryable = {
          query: <Row>(fragment: SqlFragment, op: string) => runQuery<Row>(client, fragment, op),
        };

        const result = await work(tx);
        await client.query('commit');

        const durationMs = performance.now() - started;
        if (durationMs > SLOW_QUERY_MS) {
          // Long transactions hold locks and pin the oldest visible snapshot,
          // which blocks vacuum. Worth seeing.
          logger.warn({ operation, durationMs: Math.round(durationMs) }, 'slow transaction');
        }

        return result;
      } catch (error) {
        try {
          await client.query('rollback');
        } catch (rollbackError) {
          // The connection is probably already gone. Report it and let the
          // original error propagate, since that is the useful one.
          logger.error({ operation, err: rollbackError }, 'rollback failed; discarding connection');
        }
        throw error;
      } finally {
        client.release();
      }
    },

    stats() {
      return {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      };
    },

    async close() {
      logger.info({ ...this.stats() }, 'closing database pool');
      await pool.end();
    },
  };
}
