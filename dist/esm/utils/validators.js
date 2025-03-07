import * as v from 'valibot';
export const ValiHitSchema = v.union([
    v.strictTuple([]),
    v.strictTuple([
        v.pipe(v.number(), v.integer(), v.minValue(0)),
        v.pipe(v.number(), v.integer(), v.minValue(0)),
    ]),
]);
export const ValiGetSchema = v.array(v.tuple([
    v.pipe(v.number(), v.integer(), v.minValue(-1)),
    v.pipe(v.number(), v.integer(), v.minValue(0)),
]));
