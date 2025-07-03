
    async function enviar() {
      const mensagem = document.getElementById("mensagem").value;
      const respostaEl = document.getElementById("resposta");

      respostaEl.textContent = "Pensando...";

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ message: mensagem })
        });

        const data = await res.json();

        if (data.reply) {
          respostaEl.textContent = data.reply;
        } else {
          respostaEl.textContent = "Erro: resposta vazia.";
        }
      } catch (error) {
        respostaEl.textContent = "Erro ao se comunicar com o servidor.";
        console.error(error);
      }
    }
