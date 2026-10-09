from rest_framework import serializers

from .models import Note


class NoteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Note
        fields = ["id", "title", "done"]

    def validate_title(self, value):
        if not value.strip():
            raise serializers.ValidationError("title is required")
        return value.strip()
