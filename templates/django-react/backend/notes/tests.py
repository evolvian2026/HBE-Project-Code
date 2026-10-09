from rest_framework.test import APITestCase


class NoteApiTests(APITestCase):
    def test_health(self):
        self.assertEqual(self.client.get("/health").status_code, 200)

    def test_create_and_list(self):
        created = self.client.post("/api/notes/", {"title": "Buy milk"}, format="json")
        self.assertEqual(created.status_code, 201)
        self.assertEqual(created.json()["title"], "Buy milk")
        listed = self.client.get("/api/notes/")
        self.assertEqual([n["title"] for n in listed.json()], ["Buy milk"])

    def test_title_is_required(self):
        response = self.client.post("/api/notes/", {"title": "  "}, format="json")
        self.assertEqual(response.status_code, 400)
