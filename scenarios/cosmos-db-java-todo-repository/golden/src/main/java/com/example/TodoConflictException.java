package com.example;

public final class TodoConflictException extends RuntimeException {
    public TodoConflictException(String message, Throwable cause) {
        super(message, cause);
    }
}
