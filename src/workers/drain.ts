let draining = false;
export const isWorkerDraining = () => draining;
export const beginWorkerDrain = () => { draining = true; };
