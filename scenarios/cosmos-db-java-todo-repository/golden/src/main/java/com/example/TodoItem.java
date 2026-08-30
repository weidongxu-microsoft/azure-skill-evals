package com.example;

import java.time.Instant;

public final class TodoItem {
    private String id;
    private String title;
    private String description;
    private boolean completed;
    private String createdAt;
    private String category;
    private String _etag;

    public TodoItem() {
    }

    public TodoItem(
            String id,
            String title,
            String description,
            boolean completed,
            String createdAt,
            String category) {
        this.id = id;
        this.title = title;
        this.description = description;
        this.completed = completed;
        this.createdAt = createdAt;
        this.category = category;
    }

    public static TodoItem create(
            String id, String title, String description, String category) {
        return new TodoItem(
                id, title, description, false, Instant.now().toString(), category);
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getTitle() {
        return title;
    }

    public void setTitle(String title) {
        this.title = title;
    }

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }

    public boolean isCompleted() {
        return completed;
    }

    public void setCompleted(boolean completed) {
        this.completed = completed;
    }

    public String getCreatedAt() {
        return createdAt;
    }

    public void setCreatedAt(String createdAt) {
        this.createdAt = createdAt;
    }

    public String getCategory() {
        return category;
    }

    public void setCategory(String category) {
        this.category = category;
    }

    public String getEtag() {
        return _etag;
    }

    public void setEtag(String etag) {
        this._etag = etag;
    }
}
