# Use PostgreSQL for durable storage

Production uses Azure Database for PostgreSQL Flexible Server. Windows development runs PGlite's PostgreSQL wire-protocol server over loopback, allowing the application and Better Auth to use the same `pg.Pool` adapter in both environments. The development pool has one connection because PGlite multiplexes work over a single embedded connection.
