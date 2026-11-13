import type { ModuleTile } from './plans';

export interface ShellSession {
  fullName: string;
  email: string;
  role: string;
  planName: string | null;
  planType: string | null;
  modules: string[];
  tiles: ModuleTile[];
}
