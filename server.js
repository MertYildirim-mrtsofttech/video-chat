const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

// HTTP sunucusu oluştur (static dosyalar için)
const server = http.createServer((req, res) => {
    // CORS başlıklarını ekle
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(__dirname, 'index.html');
        fs.readFile(htmlPath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Dosya bulunamadı');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else if (req.url === '/status') {
        // Sunucu durumu endpoint'i
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            activeConnections: wss ? wss.clients.size : 0,
            waitingUsers: waitingQueue.length,
            activeMatches: Math.floor(connections.size / 2),
            uptime: process.uptime()
        }));
    } else {
        res.writeHead(404);
        res.end('Sayfa bulunamadı');
    }
});

// WebSocket sunucusu oluştur
const wss = new WebSocket.Server({ server });

// Aktif bağlantıları ve kullanıcıları saklamak için
const connections = new Map(); // socket -> user data
const waitingQueue = []; // Eşleşme bekleyen kullanıcılar
const activeMatches = new Map(); // socket -> partner socket
const userHistory = new Map(); // userId -> Set of partner userIds (eşleşme geçmişi)

// Rastgele kullanıcı ID oluşturma
function generateUserId() {
    return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Kullanıcı sayısını tüm bağlı istemcilere gönder
function broadcastUserCount() {
    const userCount = connections.size;
    const message = JSON.stringify({
        type: 'user-count',
        count: userCount
    });

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Rastgele eşleşme bul - yeni algoritma ile
function findMatch(socket) {
    const currentUser = connections.get(socket);
    if (!currentUser) return;

    // Mevcut kullanıcının eşleşme geçmişini al
    const currentUserHistory = userHistory.get(currentUser.id) || new Set();
    
    // Kendi kendine eşleşmeyi önle ve bekleyen kullanıcıları filtrele
    const availableUsers = waitingQueue.filter(waitingSocket => {
        const waitingUser = connections.get(waitingSocket);
        return waitingSocket !== socket && 
               waitingUser && 
               waitingSocket.readyState === WebSocket.OPEN &&
               !activeMatches.has(waitingSocket);
    });

    if (availableUsers.length === 0) {
        return false;
    }

    // Eşleşme stratejisi: Önce yeni kullanıcıları tercih et, sonra eskilerle de eşleş
    let selectedPartner = null;
    
    // Strateji 1: Daha önce hiç konuşmadığı kullanıcıları bul
    const newUsers = availableUsers.filter(waitingSocket => {
        const waitingUser = connections.get(waitingSocket);
        return waitingUser && !currentUserHistory.has(waitingUser.id);
    });
    
    // Strateji 2: Eğer yeni kullanıcı varsa onlardan birini seç
    if (newUsers.length > 0) {
        const randomIndex = Math.floor(Math.random() * newUsers.length);
        selectedPartner = newUsers[randomIndex];
        console.log(`${currentUser.username} için YENİ kullanıcı bulundu`);
    } 
    // Strateji 3: Yeni kullanıcı yoksa, daha önce konuştuklarından rastgele seç
    else {
        const randomIndex = Math.floor(Math.random() * availableUsers.length);
        selectedPartner = availableUsers[randomIndex];
        console.log(`${currentUser.username} için ESKİ kullanıcı ile yeniden eşleşme`);
    }

    if (!selectedPartner) return false;

    const partnerUser = connections.get(selectedPartner);
    
    // Her iki kullanıcıyı da bekleme kuyruğundan çıkar
    removeFromWaitingQueue(socket);
    removeFromWaitingQueue(selectedPartner);

    // Eşleşmeyi kaydet
    activeMatches.set(socket, selectedPartner);
    activeMatches.set(selectedPartner, socket);
    
    // Eşleşme geçmişini güncelle (her iki taraf için)
    if (!userHistory.has(currentUser.id)) {
        userHistory.set(currentUser.id, new Set());
    }
    if (!userHistory.has(partnerUser.id)) {
        userHistory.set(partnerUser.id, new Set());
    }
    
    userHistory.get(currentUser.id).add(partnerUser.id);
    userHistory.get(partnerUser.id).add(currentUser.id);

    // Her iki kullanıcıya da eşleşmeyi bildir
    socket.send(JSON.stringify({
        type: 'partner-found',
        partner: partnerUser.username,
        isInitiator: true,
        isReconnection: currentUserHistory.has(partnerUser.id) // Tekrar eşleşme mi?
    }));

    selectedPartner.send(JSON.stringify({
        type: 'partner-found',
        partner: currentUser.username,
        isInitiator: false,
        isReconnection: userHistory.get(partnerUser.id).has(currentUser.id) // Tekrar eşleşme mi?
    }));

    console.log(`Eşleşme oluşturuldu: ${currentUser.username} <-> ${partnerUser.username} ${currentUserHistory.has(partnerUser.id) ? '(TEKRAR)' : '(YENİ)'}`);
    
    return true;
}

// Kullanıcıyı bekleme kuyruğuna ekle
function addToWaitingQueue(socket) {
    if (!waitingQueue.includes(socket)) {
        waitingQueue.push(socket);
        console.log(`Kullanıcı bekleme kuyruğuna eklendi. Toplam bekleyen: ${waitingQueue.length}`);
    }
}

// Kullanıcıyı bekleme kuyruğundan çıkar
function removeFromWaitingQueue(socket) {
    const index = waitingQueue.indexOf(socket);
    if (index > -1) {
        waitingQueue.splice(index, 1);
        console.log(`Kullanıcı bekleme kuyruğundan çıkarıldı. Kalan: ${waitingQueue.length}`);
    }
}

// Aktif eşleşmeyi sonlandır
function endMatch(socket) {
    const partnerSocket = activeMatches.get(socket);
    
    if (partnerSocket) {
        // Partner'a ayrılığı bildir
        if (partnerSocket.readyState === WebSocket.OPEN) {
            partnerSocket.send(JSON.stringify({
                type: 'partner-left'
            }));
        }

        // Eşleşmeleri temizle
        activeMatches.delete(socket);
        activeMatches.delete(partnerSocket);

        const currentUser = connections.get(socket);
        const partnerUser = connections.get(partnerSocket);
        
        console.log(`Eşleşme sonlandırıldı: ${currentUser?.username || 'Unknown'} <-> ${partnerUser?.username || 'Unknown'}`);
        
        // Partner'ı tekrar bekleme kuyruğuna ekle (eğer hala bağlıysa)
        if (partnerSocket.readyState === WebSocket.OPEN && connections.has(partnerSocket)) {
            addToWaitingQueue(partnerSocket);
            
            // Partner için otomatik eşleşme ara
            setTimeout(() => {
                if (waitingQueue.includes(partnerSocket)) {
                    findMatch(partnerSocket);
                }
            }, 1000);
        }
    }
}

// Mesajı partner'a ilet
function forwardToPartner(socket, message) {
    const partnerSocket = activeMatches.get(socket);
    
    if (partnerSocket && partnerSocket.readyState === WebSocket.OPEN) {
        partnerSocket.send(JSON.stringify(message));
        return true;
    }
    
    return false;
}

// Tüm WebSocket bağlantılarını dinle
wss.on('connection', (ws) => {
    console.log('Yeni WebSocket bağlantısı kuruldu');
    
    // Kullanıcı sayısını güncelle
    setTimeout(broadcastUserCount, 100);
    
    // Mesaj dinleyicisi
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Mesaj alındı:', data.type, data.username || '');
            
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
        handleDisconnect(ws);
    });
});

function handleMessage(socket, data) {
    switch (data.type) {
        case 'find-partner':
            handleFindPartner(socket, data);
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
            
        case 'disconnect':
            handleDisconnectRequest(socket);
            break;
            
        default:
            console.log('Bilinmeyen mesaj tipi:', data.type);
    }
}

function handleFindPartner(socket, data) {
    const { username } = data;
    
    // Kullanıcı adı validasyonu
    if (!username || username.length < 2 || username.length > 20) {
        sendError(socket, 'Geçersiz kullanıcı adı!');
        return;
    }

    // Var olan kullanıcıyı kontrol et (tekrar bağlanan kullanıcı için)
    let userId = generateUserId();
    let existingHistory = new Set();
    
    // Aynı kullanıcı adına sahip önceki kayıtları ara (basit tekrar bağlanma tespiti)
    for (const [existingUserId, history] of userHistory.entries()) {
        // Bu basit bir yaklaşım - gerçek uygulamada daha sofistike kimlik doğrulama kullanılabilir
        if (existingUserId.includes(username)) {
            userId = existingUserId;
            existingHistory = history;
            console.log(`${username} tekrar bağlandı - geçmiş eşleşmeler geri yüklendi: ${existingHistory.size}`);
            break;
        }
    }

    // Kullanıcıyı kaydet
    const user = {
        id: userId,
        username: username.trim(),
        socket: socket,
        joinedAt: new Date(),
        previousConnections: existingHistory.size // İstatistik için
    };
    
    connections.set(socket, user);
    console.log(`Kullanıcı kaydedildi: ${username} (ID: ${userId}) - Önceki eşleşme: ${existingHistory.size}`);
    
    // Geçmişi güncelle (eğer yeni kullanıcıysa)
    if (!userHistory.has(userId)) {
        userHistory.set(userId, new Set());
    }
    
    // Mevcut eşleşmesi varsa sonlandır
    if (activeMatches.has(socket)) {
        endMatch(socket);
    }
    
    // Bekleme kuyruğundan çıkar (eğer varsa)
    removeFromWaitingQueue(socket);
    
    // Eşleşme bul
    const matchFound = findMatch(socket);
    
    // Eşleşme bulunamadıysa bekleme kuyruğuna ekle
    if (!matchFound) {
        addToWaitingQueue(socket);
        console.log(`${username} eşleşme bekliyor... (Geçmiş partner sayısı: ${existingHistory.size})`);
    }
    
    // Kullanıcı sayısını güncelle
    broadcastUserCount();
}

function handleOffer(socket, data) {
    const success = forwardToPartner(socket, {
        type: 'offer',
        offer: data.offer
    });
    
    if (!success) {
        sendError(socket, 'Partner bulunamadı! Yeniden eşleşme deneniyor.');
        handleDisconnectRequest(socket);
    }
}

function handleAnswer(socket, data) {
    const success = forwardToPartner(socket, {
        type: 'answer',
        answer: data.answer
    });
    
    if (!success) {
        sendError(socket, 'Partner bulunamadı! Yeniden eşleşme deneniyor.');
        handleDisconnectRequest(socket);
    }
}

function handleIceCandidate(socket, data) {
    forwardToPartner(socket, {
        type: 'ice-candidate',
        candidate: data.candidate
    });
}

function handleChatMessage(socket, data) {
    const { message, sender } = data;
    
    // Mesaj validasyonu
    if (!message || message.trim().length === 0) return;
    if (message.length > 500) {
        sendError(socket, 'Mesaj çok uzun! Maksimum 500 karakter.');
        return;
    }
    
    const success = forwardToPartner(socket, {
        type: 'chat-message',
        message: message.trim(),
        sender: sender
    });
    
    if (success) {
        const user = connections.get(socket);
        console.log(`Chat: [${user?.username || 'Unknown'}] ${message}`);
    }
}

function handleDisconnectRequest(socket) {
    endMatch(socket);
    removeFromWaitingQueue(socket);
    
    // Yeni eşleşme ara
    setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN && connections.has(socket)) {
            const user = connections.get(socket);
            handleFindPartner(socket, { username: user.username });
        }
    }, 500);
}

function handleDisconnect(socket) {
    // Aktif eşleşmeyi sonlandır
    endMatch(socket);
    
    // Bekleme kuyruğundan çıkar
    removeFromWaitingQueue(socket);
    
    // Bağlantıları temizle
    const user = connections.get(socket);
    connections.delete(socket);
    
    // NOT: userHistory'yi silmiyoruz - böylece kullanıcı tekrar bağlandığında geçmişi hatırlanır
    // userHistory.delete(user?.id); // Bu satırı kasten yorum yapıyoruz
    
    if (user) {
        console.log(`Kullanıcı ayrıldı: ${user.username} (ID: ${user.id})`);
        console.log(`Kullanıcının eşleşme geçmişi korundu: ${userHistory.get(user.id)?.size || 0} partner`);
    }
    
    // Kullanıcı sayısını güncelle
    setTimeout(broadcastUserCount, 100);
}

function sendError(socket, message) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'error',
            message: message
        }));
    }
}

// Sunucuyu başlat
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Video Chat Sunucusu başlatıldı!`);
    console.log(`📡 HTTP Server: http://localhost:${PORT}`);
    console.log(`🔌 WebSocket Server: ws://localhost:${PORT}`);
    console.log(`👥 Maksimum bağlantı: Sınırsız`);
    console.log('───────────────────────────────────────');
});

// Periyodik temizlik - kopmuş bağlantıları temizle
setInterval(() => {
    let cleanedConnections = 0;
    let cleanedWaiting = 0;
    let cleanedMatches = 0;
    
    // Kopmuş bağlantıları temizle
    for (const [socket, user] of connections.entries()) {
        if (socket.readyState !== WebSocket.OPEN) {
            connections.delete(socket);
            cleanedConnections++;
        }
    }
    
    // Kopmuş kullanıcıları bekleme kuyruğundan temizle
    for (let i = waitingQueue.length - 1; i >= 0; i--) {
        const socket = waitingQueue[i];
        if (socket.readyState !== WebSocket.OPEN || !connections.has(socket)) {
            waitingQueue.splice(i, 1);
            cleanedWaiting++;
        }
    }
    
    // Kopmuş eşleşmeleri temizle
    for (const [socket, partner] of activeMatches.entries()) {
        if (socket.readyState !== WebSocket.OPEN || 
            partner.readyState !== WebSocket.OPEN ||
            !connections.has(socket) || 
            !connections.has(partner)) {
            activeMatches.delete(socket);
            activeMatches.delete(partner);
            cleanedMatches++;
        }
    }
    
    if (cleanedConnections > 0 || cleanedWaiting > 0 || cleanedMatches > 0) {
        console.log(`🧹 Temizlik: ${cleanedConnections} bağlantı, ${cleanedWaiting} bekleme, ${cleanedMatches} eşleşme`);
        broadcastUserCount();
    }
    
}, 30000); // Her 30 saniyede bir

// Sunucu istatistikleri - her dakika
setInterval(() => {
    const totalHistoryEntries = Array.from(userHistory.values()).reduce((sum, set) => sum + set.size, 0);
    const averageConnections = userHistory.size > 0 ? (totalHistoryEntries / userHistory.size).toFixed(1) : 0;
    
    console.log('📊 Sunucu İstatistikleri:');
    console.log(`   👥 Aktif kullanıcı: ${connections.size}`);
    console.log(`   ⏳ Bekleyen: ${waitingQueue.length}`);
    console.log(`   💑 Aktif eşleşme: ${Math.floor(activeMatches.size / 2)}`);
    console.log(`   🔌 WebSocket bağlantısı: ${wss.clients.size}`);
    console.log(`   📚 Kayıtlı kullanıcı geçmişi: ${userHistory.size}`);
    console.log(`   🔄 Ortalama eşleşme/kullanıcı: ${averageConnections}`);
    console.log(`   ⏱️  Çalışma süresi: ${Math.floor(process.uptime())}s`);
    console.log('───────────────────────────────────────');
}, 60000); // Her dakika

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Sunucu kapatılıyor...');
    
    // Tüm kullanıcılara bildir
    const shutdownMessage = JSON.stringify({
        type: 'error',
        message: 'Sunucu bakım için kapatılıyor. Lütfen daha sonra tekrar deneyin.'
    });
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(shutdownMessage);
            client.close();
        }
    });
    
    setTimeout(() => {
        server.close(() => {
            console.log('✅ Sunucu kapatıldı.');
            process.exit(0);
        });
    }, 1000);
});

console.log('🎯 Rastgele Video Chat Sunucusu hazır!');