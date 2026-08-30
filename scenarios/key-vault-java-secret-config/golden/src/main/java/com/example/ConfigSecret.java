package com.example;

import java.time.OffsetDateTime;

public record ConfigSecret(String value, OffsetDateTime expiresOn) {
}
