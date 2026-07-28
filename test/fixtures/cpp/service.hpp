#pragma once

class BaseService {
public:
    virtual int run(int value) = 0;
};

class Service : public BaseService {
public:
    int run(int value) override;
};

int helper(int value);
