const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');
const { Server } = require('socket.io');

const User = require('./model/user');
const GroupMessage = require('./model/groupMessage');
const PrivateMessage = require('./model/privateMessage');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'view')));

// MongoDB connection
mongoose.connect('mongodb://localhost:27017/chat_app')
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// Predefined rooms
const ROOMS = ['devops', 'cloud computing', 'covid19', 'sports', 'nodeJS'];

// Track online users: { socketId: { username, room } }
const onlineUsers = {};

// ===================== REST API ROUTES =====================

// Signup
app.post('/api/signup', async (req, res) => {
    try {
        const { username, firstname, lastname, password } = req.body;
        // Check if username already exists
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ error: 'Username already exists' });
        }
        const hashedPassword = await bcrypt.hash(password, 10);
        const user = new User({ username, firstname, lastname, password: hashedPassword });
        await user.save();
        res.status(201).json({ message: 'User created successfully' });
    } catch (err) {
        if (err.name === 'ValidationError') {
            const messages = Object.values(err.errors).map(e => e.message);
            return res.status(400).json({ error: messages.join(', ') });
        }
        res.status(500).json({ error: 'Server error' });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }
        res.json({ message: 'Login successful', username: user.username, firstname: user.firstname });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get rooms
app.get('/api/rooms', (req, res) => {
    res.json(ROOMS);
});

// Get room message history
app.get('/api/messages/room/:room', async (req, res) => {
    try {
        const messages = await GroupMessage.find({ room: req.params.room })
            .sort({ date_sent: 1 }).limit(100);
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// Get private message history between two users
app.get('/api/messages/private/:user1/:user2', async (req, res) => {
    try {
        const { user1, user2 } = req.params;
        const messages = await PrivateMessage.find({
            $or: [
                { from_user: user1, to_user: user2 },
                { from_user: user2, to_user: user1 }
            ]
        }).sort({ date_sent: 1 }).limit(100);
        res.json(messages);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ===================== SOCKET.IO =====================

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Register user
    socket.on('registerUser', (username) => {
        onlineUsers[socket.id] = { username, room: null };
        console.log(`${username} registered`);
    });

    // Join room
    socket.on('joinRoom', (room) => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        // Leave current room if any
        if (user.room) {
            socket.leave(user.room);
            io.to(user.room).emit('roomMessage', {
                from_user: 'System',
                message: `${user.username} has left the room`,
                date_sent: new Date()
            });
            io.to(user.room).emit('updateUsers', getUsersInRoom(user.room));
        }

        // Join new room
        user.room = room;
        socket.join(room);
        io.to(room).emit('roomMessage', {
            from_user: 'System',
            message: `${user.username} has joined the room`,
            date_sent: new Date()
        });
        io.to(room).emit('updateUsers', getUsersInRoom(room));
    });

    // Leave room
    socket.on('leaveRoom', () => {
        const user = onlineUsers[socket.id];
        if (!user || !user.room) return;

        const room = user.room;
        socket.leave(room);
        user.room = null;
        io.to(room).emit('roomMessage', {
            from_user: 'System',
            message: `${user.username} has left the room`,
            date_sent: new Date()
        });
        io.to(room).emit('updateUsers', getUsersInRoom(room));
    });

    // Group message
    socket.on('groupMessage', async (data) => {
        const user = onlineUsers[socket.id];
        if (!user || !user.room) return;

        const msg = new GroupMessage({
            from_user: user.username,
            room: user.room,
            message: data.message
        });
        await msg.save();

        io.to(user.room).emit('roomMessage', {
            from_user: user.username,
            message: data.message,
            date_sent: msg.date_sent
        });
    });

    // Private message
    socket.on('privateMessage', async (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        const msg = new PrivateMessage({
            from_user: user.username,
            to_user: data.to_user,
            message: data.message
        });
        await msg.save();

        // Find recipient socket
        const recipientSocketId = Object.keys(onlineUsers).find(
            id => onlineUsers[id].username === data.to_user
        );

        // Send to recipient
        if (recipientSocketId) {
            io.to(recipientSocketId).emit('privateMessage', {
                from_user: user.username,
                to_user: data.to_user,
                message: data.message,
                date_sent: msg.date_sent
            });
        }

        // Send back to sender
        socket.emit('privateMessage', {
            from_user: user.username,
            to_user: data.to_user,
            message: data.message,
            date_sent: msg.date_sent
        });
    });

    // Typing indicators
    socket.on('typing', (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        if (data.to_user) {
            // Private typing
            const recipientSocketId = Object.keys(onlineUsers).find(
                id => onlineUsers[id].username === data.to_user
            );
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('typing', { from_user: user.username });
            }
        } else if (user.room) {
            // Room typing
            socket.to(user.room).emit('typing', { from_user: user.username });
        }
    });

    socket.on('stopTyping', (data) => {
        const user = onlineUsers[socket.id];
        if (!user) return;

        if (data && data.to_user) {
            const recipientSocketId = Object.keys(onlineUsers).find(
                id => onlineUsers[id].username === data.to_user
            );
            if (recipientSocketId) {
                io.to(recipientSocketId).emit('stopTyping', { from_user: user.username });
            }
        } else if (user.room) {
            socket.to(user.room).emit('stopTyping', { from_user: user.username });
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        const user = onlineUsers[socket.id];
        if (user && user.room) {
            io.to(user.room).emit('roomMessage', {
                from_user: 'System',
                message: `${user.username} has disconnected`,
                date_sent: new Date()
            });
            io.to(user.room).emit('updateUsers', getUsersInRoom(user.room));
        }
        delete onlineUsers[socket.id];
        console.log('User disconnected:', socket.id);
    });
});

function getUsersInRoom(room) {
    return Object.values(onlineUsers)
        .filter(u => u.room === room)
        .map(u => u.username);
}

// Start server
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
