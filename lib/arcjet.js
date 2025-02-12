import arcjet, { tokenBucket } from "@arcjet/next";

const aj = arcjet({
    key: process.env.ARCJET_KEY,
    characteristics: ["userId"], // Track based on clerk userId
    rules: [
        tokenBucket({
            mode: "LIVE",
            refillRate:2,
            interval: 3600,
            capacity: 2,
        })
    ]
})

export default aj;