import { Chess } from 'chess.js';
// import { Equine } from 'equine'; // Logic would go here if we were using it directly, assume fetch for now if equine is node-only

let chess;
const LICHESS_TOKEN = "lip_1ZNKqIHrmYiPcecQShV8"; // Hardcoded for this env, usually env var
let gameId = null;

export async function initGame() {
    chess = new Chess();
    console.log("Game initialized", chess.ascii());
    
    // Attempt to connect to Lichess or start a game
    // For now, we just log the token presence
    console.log("Using Lichess Token:", LICHESS_TOKEN.substr(0,4) + "...");

    return {
        chess,
        move: async (from, to) => {
            try {
                // 1. Validate locally
                const move = chess.move({ from, to, promotion: 'q' });
                if (move) {
                    console.log("Move successful", move);
                    
                    // 2. Send to Lichess if connected
                    if (gameId) {
                         // fetch(`https://lichess.org/api/board/game/${gameId}/move/${move.lan}`, ...);
                    }
                    
                    return move;
                }
            } catch (e) {
                console.warn("Invalid move", e);
            }
            return null;
        },
        getFen: () => chess.fen(),
        isGameOver: () => chess.isGameOver(),
        turn: () => chess.turn() // 'w' or 'b'
    };
}

