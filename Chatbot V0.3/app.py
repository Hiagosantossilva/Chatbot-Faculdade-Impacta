from flask import Flask, render_template, request, jsonify
from mistralai.client import MistralClient
from mistralai.models.chat_completion import ChatMessage

app = Flask(__name__)

api_key = "API_KEY"  # chave correta aqui
client = MistralClient(api_key=api_key)
model = "mistral-large-latest"

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/chat', methods=['POST'])
def chat():
    data = request.get_json()
    user_message = data.get("message")

    response = client.chat(
        model=model,
        messages=[
            ChatMessage(role="user", content=f"Você é o assistente de IA da Faculdade Impacta. Um aluno lhe perguntou: {user_message}")
        ],
        max_tokens=200
    )

    return jsonify({"response": response.choices[0].message.content})

if __name__ == '__main__':
    app.run(debug=True)
