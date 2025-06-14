import os
from mistralai import Mistral
#Importações necessárias

MISTRAL_API_KEY='API_KEY'
os.environ["MISTRAL_API_KEY"] = MISTRAL_API_KEY
api_key = os.environ["MISTRAL_API_KEY"]
model = "mistral-large-latest"

client = Mistral(api_key=api_key)
user_message= input("Digite sua mensagem: ")
chat_response = client.chat.complete(
    model = model,
    messages = [
        {
            "role": "user",
            "content": 'Você é o assistente de IA da Faculdade Impacta. Um aluno lhe perguntou:' + user_message,
        },
    ], max_tokens=15

)

print(chat_response.choices[0].message.content)