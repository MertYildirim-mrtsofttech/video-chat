const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

// HTTP sunucusu oluştur (static dosyalar için)
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(__dirname, 'index.html');
        fs.readFile(htmlPath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Dosya bulunamadı');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('Sayfa bulunamadı');
    }
});

// WebSocket sunucusu oluştur
const wss = new WebSocket.Server({ server });

// Aktif odalar ve kullanıcıları saklamak için
const rooms = new Map();
const userSockets = new Map();

// Rastgele oda ID oluşturma fonksiyonu
function generateRoomId() {
    return 'room_' + Math.random().toString(36).substr(2, 9);
}

// Tüm bağlantıları dinle
wss.on('connection', (ws) => {
    console.log('Yeni WebSocket bağlantısı kuruldu');
    
    let currentUser = null;
    let currentRoom = null;

    // Mesaj dinleyicisi
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Mesaj alındı:', data);
            
            handleMessage(ws, data);
        } catch (error) {
            console.error('Mesaj parse hatası:', error);
            sendError(ws, 'Geçersiz mesaj formatı');
        }
    });

    // Bağlantı kapanması
    ws.on('close', () => {
        console.log('WebSocket bağlantısı kapandı');
        handleDisconnect(ws);
    });

    // Hata durumu
    ws.on('error', (error) => {
        console.error('WebSocket hatası:', error);
    });

    function handleMessage(socket, data) {
        switch (data.type) {
            case 'create-room':
                handleCreateRoom(socket, data);
                break;
                
            case 'join-room':
                handleJoinRoom(socket, data);
                break;
                
            case 'leave-room':
                handleLeaveRoom(socket, data);
                break;
                
            case 'offer':
                handleOffer(socket, data);
                break;
                
            case 'answer':
                handleAnswer(socket, data);
                break;
                
            case 'ice-candidate':
                handleIceCandidate(socket, data);
                break;
                
            case 'chat-message':
                handleChatMessage(socket, data);
                break;
                
            default:
                console.log('Bilinmeyen mesaj tipi:', data.type);
        }
    }

    function handleCreateRoom(socket, data) {
        const { username } = data;
        const roomId = generateRoomId();
        
        // Yeni oda oluştur
        rooms.set(roomId, {
            users: new Map(),
            createdAt: new Date()
        });
        
        // Kullanıcıyı odaya ekle
        const user = {
            username: username,
            socket: socket,
            isInitiator: true
        };
        
        rooms.get(roomId).users.set(socket, user);
        currentUser = user;
        currentRoom = roomId;
        userSockets.set(socket, { user, roomId });
        
        // Başarılı yanıt gönder
        socket.send(JSON.stringify({
            type: 'room-created',
            roomId: roomId,
            username: username
        }));
        
        console.log(`Oda oluşturuldu: ${roomId}, Kullanıcı: ${username}`);
    }

    function handleJoinRoom(socket, data) {
        const { roomId, username } = data;
        
        // Oda var mı kontrol et
        if (!rooms.has(roomId)) {
            sendError(socket, 'Oda bulunamadı!');
            return;
        }
        
        const room = rooms.get(roomId);
        
        // Oda dolu mu kontrol et (maksimum 2 kişi)
        if (room.users.size >= 2) {
            sendError(socket, 'Oda dolu! Maksimum 2 kişi katılabilir.');
            return;
        }
        
        // Aynı kullanıcı adı var mı kontrol et
        const existingUsernames = Array.from(room.users.values()).map(u => u.username);
        if (existingUsernames.includes(username)) {
            sendError(socket, 'Bu kullanıcı adı zaten kullanılıyor!');
            return;
        }
        
        // Kullanıcıyı odaya ekle
        const user = {
            username: username,
            socket: socket,
            isInitiator: false
        };
        
        room.users.set(socket, user);
        currentUser = user;
        currentRoom = roomId;
        userSockets.set(socket, { user, roomId });
        
        // Katılana onay gönder
        socket.send(JSON.stringify({
            type: 'room-joined',
            roomId: roomId,
            username: username
        }));
        
        // Odadaki diğer kullanıcılara bildir
        broadcastToRoom(roomId, {
            type: 'user-joined',
            username: username
        }, socket);
        
        console.log(`${username} odaya katıldı: ${roomId}`);
    }

    function handleLeaveRoom(socket, data) {
        const userInfo = userSockets.get(socket);
        if (userInfo) {
            const { roomId } = userInfo;
            leaveRoom(socket, roomId);
        }
    }

    function handleOffer(socket, data) {
        const { offer, roomId } = data;
        
        // Odadaki diğer kullanıcılara offer'ı ilet
        broadcastToRoom(roomId, {
            type: 'offer',
            offer: offer
        }, socket);
        
        console.log('Offer iletildi:', roomId);
    }

    function handleAnswer(socket, data) {
        const { answer, roomId } = data;
        
        // Odadaki diğer kullanıcılara answer'ı ilet
        broadcastToRoom(roomId, {
            type: 'answer',
            answer: answer
        }, socket);
        
        console.log('Answer iletildi:', roomId);
    }

    function handleIceCandidate(socket, data) {
        const { candidate, roomId } = data;
        
        // Odadaki diğer kullanıcılara ICE candidate'ı ilet
        broadcastToRoom(roomId, {
            type: 'ice-candidate',
            candidate: candidate
        }, socket);
        
        console.log('ICE candidate iletildi:', roomId);
    }

    function handleChatMessage(socket, data) {
        const { message, roomId, sender } = data;
        
        // Odadaki diğer kullanıcılara mesajı ilet
        broadcastToRoom(roomId, {
            type: 'chat-message',
            message: message,
            sender: sender
        }, socket);
        
        console.log(`Chat mesajı: [${roomId}] ${sender}: ${message}`);
    }

    function handleDisconnect(socket) {
        const userInfo = userSockets.get(socket);
        if (userInfo) {
            const { roomId, user } = userInfo;
            leaveRoom(socket, roomId);
        }
    }

    function leaveRoom(socket, roomId) {
        if (!rooms.has(roomId)) return;
        
        const room = rooms.get(roomId);
        const user = room.users.get(socket);
        
        if (user) {
            // Kullanıcıyı odadan çıkar
            room.users.delete(socket);
            userSockets.delete(socket);
            
            // Odadaki diğer kullanıcılara bildir
            broadcastToRoom(roomId, {
                type: 'user-left',
                username: user.username
            });
            
            console.log(`${user.username} odadan ayrıldı: ${roomId}`);
            
            // Oda boşsa sil
            if (room.users.size === 0) {
                rooms.delete(roomId);
                console.log(`Boş oda silindi: ${roomId}`);
            }
        }
    }

    function broadcastToRoom(roomId, message, excludeSocket = null) {
        if (!rooms.has(roomId)) return;
        
        const room = rooms.get(roomId);
        const messageStr = JSON.stringify(message);
        
        room.users.forEach((user, socket) => {
            if (socket !== excludeSocket && socket.readyState === WebSocket.OPEN) {
                socket.send(messageStr);
            }
        });
    }

    function sendError(socket, message) {
        socket.send(JSON.stringify({
            type: 'error',
            message: message
        }));
    }
});

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
    console.log(`WebSocket sunucu: ws://localhost:${PORT}`);
    console.log('Aktif odalar:', rooms.size);
});

// Periyodik olarak boş odaları temizle
setInterval(() => {
    const now = new Date();
    const expiredRooms = [];
    
    rooms.forEach((room, roomId) => {
        // 1 saat boyunca boş olan odaları sil
        if (room.users.size === 0 && (now - room.createdAt) > 3600000) {
            expiredRooms.push(roomId);
        }
    });
    
    expiredRooms.forEach(roomId => {
        rooms.delete(roomId);
        console.log(`Süresi dolmuş oda silindi: ${roomId}`);
    });
    
}, 300000); // 5 dakikada bir kontrol et

// Sunucu durumu endpoint'i
server.on('request', (req, res) => {
    if (req.url === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            activeRooms: rooms.size,
            activeConnections: wss.clients.size,
            uptime: process.uptime()
        }));
        return;
    }
});

console.log('WebSocket Video Chat Sunucusu başlatıldı...');