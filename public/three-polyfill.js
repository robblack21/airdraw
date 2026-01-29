
export * from "https://unpkg.com/three@0.178.0/build/three.module.js";

// Polyfill Matrix2 for Spark.js compatibility
// Three.js removed Matrix2 long ago, but Spark.js (0.1.10) seems to rely on it (or a custom build).
export class Matrix2 {
    constructor() {
        this.elements = [
            1, 0,
            0, 1
        ];
    }

    set(n11, n12, n21, n22) {
        const te = this.elements;
        te[0] = n11; te[2] = n12;
        te[1] = n21; te[3] = n22;
        return this;
    }

    identity() {
        this.set(1, 0, 0, 1);
        return this;
    }

    copy(m) {
        const te = this.elements;
        const me = m.elements;
        te[0] = me[0]; te[1] = me[1];
        te[2] = me[2]; te[3] = me[3];
        return this;
    }
    
    clone() {
        return new Matrix2().copy(this);
    }
}
