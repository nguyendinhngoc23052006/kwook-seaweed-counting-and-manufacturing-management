export interface Blob {
  area: number;
  cx: number;
  cy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Track {
  id: number;
  cx: number;
  cy: number;
  age: number;
  missed: number;
  counted: boolean;
}

export interface OtsuResult {
  threshold: number;
  separability: number;
}
