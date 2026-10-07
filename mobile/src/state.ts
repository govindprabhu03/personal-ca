import type { Bootstrap } from '../../shared/types';

/** Every screen gets the bootstrap data plus `version`: it is bumped after any write, which makes screens refetch. */
export interface ScreenProps { data: Bootstrap; version: number; bump: () => void }
