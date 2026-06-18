const SERVICE_URLS = [
    "https://bot1-rec.nkhcks.easypanel.host/verify",
    "https://robikcafe.et/verify"
];

const REQUEST_TIMEOUT_MS = 15000;

async function postVerify(url, payload) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        const contentType = response.headers.get("content-type") || "";
        const isJson = contentType.includes("application/json");
        const body = isJson ? await response.json() : await response.text();

        if (!response.ok) {
            const error = new Error(`HTTP ${response.status}`);
            error.status = response.status;
            error.body = body;
            throw error;
        }

        return body;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function verifyPayment(userInput, expectedAmount) {
    const parsedExpectedAmount = Number(expectedAmount);
    const normalizedExpectedAmount = Number.isFinite(parsedExpectedAmount) && parsedExpectedAmount > 10
        ? parsedExpectedAmount
        : 11;
    const urlsToTry = [...SERVICE_URLS, ...SERVICE_URLS];

    for (const url of urlsToTry) {
        try {
            const data = await postVerify(url, {
                userInput,
                expectedAmount: normalizedExpectedAmount
            });
            return data;
        } catch (e) {
            const status = e?.status;
            const responseBody = e?.body;
            const serviceMessage = typeof responseBody === "string"
                ? responseBody
                : responseBody?.message;

            if (status >= 400 && status < 500) {
                console.error(`Receipt service validation error (${url}):`, serviceMessage || e.message);
                return {
                    valid: false,
                    message: serviceMessage || "Invalid receipt data.",
                    status
                };
            }

            console.error(`Receipt service error (${url}):`, serviceMessage || e.message);
        }
    }
    return { valid: false, message: "❌ **Service Error**: Could not verify receipt at this time." };
}

module.exports = {
    verifyPayment
};
