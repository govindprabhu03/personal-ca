// Barrel: the pure service layer is shared with the phone (shared/core/service.ts); import/backup/restore need Node, so they live apart.
export * from '../../shared/core/service';
export * from './service-node';
